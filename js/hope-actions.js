const HOPE_MODULE = 'foundry-vtt-hope-actions';
const HOPE_FLAG = 'hope';

Hooks.once('init', () => {
  console.log('Hope Actions | Initializing module');

  game.settings.register(HOPE_MODULE, 'maxHope', {
    name: `${HOPE_MODULE}.settings.maxHope.name`,
    hint: `${HOPE_MODULE}.settings.maxHope.hint`,
    scope: 'world',
    config: true,
    type: Number,
    default: 5,
    range: {
      min: 1,
      max: 20,
      step: 1
    }
  });

  game.settings.register(HOPE_MODULE, 'showAwardButtonFailedRolls', {
    name: `${HOPE_MODULE}.settings.showAwardButtonFailedRolls.name`,
    hint: `${HOPE_MODULE}.settings.showAwardButtonFailedRolls.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once('ready', () => {
  if (game.system?.id !== 'dnd5e') {
    ui.notifications.warn('Hope Actions requires the D&D 5E system.');
    return;
  }

  game[HOPE_MODULE] = {};

  Hooks.on('renderCharacterActorSheet', renderActorSheetHopeControls);
  Hooks.on('dnd5e.renderChatMessage', renderHopeActionButton);
});

function clampHope(value) {
  const maxHope = game.settings.get(HOPE_MODULE, 'maxHope');
  return Math.min(Math.max(Number(value) || 0, 0), maxHope);
}

function getActorHope(actor) {
  return Number(actor.getFlag(HOPE_MODULE, HOPE_FLAG) ?? 0);
}

async function setActorHope(actor, amount) {
  amount = clampHope(amount);
  await actor.setFlag(HOPE_MODULE, HOPE_FLAG, amount);
  return amount;
}

async function adjustActorHope(actor, delta) {
  return setActorHope(actor, getActorHope(actor) + delta);
}

async function spendActorHope(actor, amount) {
  const current = getActorHope(actor);
  const spend = Math.min(amount, current);
  if (spend <= 0) return 0;
  await setActorHope(actor, current - spend);
  return spend;
}

async function awardActorHope(actor, amount = 1, reason = '') {
  const current = getActorHope(actor);
  const maxHope = game.settings.get(HOPE_MODULE, 'maxHope');
  if (current >= maxHope) {
    const roll = await new Roll('1d4').roll();
    const newValue = roll.total;
    await setActorHope(actor, newValue);
    const content = `<p>${actor.name} already had ${maxHope} Hope and drops to ${newValue} Hope (${roll.formula}).</p>`;
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({actor}),
      content
    });
    return newValue;
  }

  const next = clampHope(current + amount);
  await setActorHope(actor, next);

  const content = `<p>${actor.name} gains ${amount} Hope${reason ? ` (${reason})` : ''}. Current Hope: ${next}/${maxHope}.</p>`;
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({actor}),
    content
  });

  return next;
}

function isNaturalOneMessage(message) {
  const rolls = message.rolls ?? [];
  return rolls.some(roll =>
    roll.dice?.some(die =>
      die.faces === 20 && die.results?.some(r => r.result === 1 && (r.active ?? true))
    )
  );
}

function renderActorSheetHopeControls(app, html, data) {
  const actor = app.actor;
  if (!actor) return;
  const $html = html instanceof jQuery ? html : $(html);
  const $root = app.element
    ? (app.element instanceof jQuery ? app.element : $(app.element))
    : $html;

  // Prefer placing next to ability scores. Fallback to header right, then header.
  const $target =
    $root.find('.ability-scores').first().length
      ? $root.find('.ability-scores').first()
      : ($root.find('.sheet-header .right').first().length
        ? $root.find('.sheet-header .right').first()
        : $root.find('.sheet-header').first());
  if (!$target.length) return;

  // Avoid duplicate injection on partial re-renders.
  $root.find('.hope-actions-sheet').remove();

  const currentHope = getActorHope(actor);

  const control = $(
    `<div class="hope-actions-sheet">
      <span class="hope-actions-value">Hope ${currentHope}/${game.settings.get(HOPE_MODULE, 'maxHope')}</span>
      ${(actor.isOwner || game.user.isGM) ? '<button class="hope-actions-award button" type="button">Award Hope</button>' : ''}
    </div>`
  );

  if ($target.is('.ability-scores')) {
    $target.append(control);
  } else {
    $target.prepend(control);
  }

  control.on('click', '.hope-actions-award', async () => {
    await awardActorHope(actor, 1, 'award');
  });

}

async function renderHopeActionButton(message, html) {
  const flags = message.flags?.dnd5e?.roll ?? {};
  const actor = ChatMessage.getSpeakerActor(message.speaker);
  const $html = html instanceof jQuery ? html : $(html);

  if (!actor) return;
  const canManageHope = actor.isOwner || game.user.isGM;
  if (!canManageHope) return;

  const showAwardButtonFailedRolls = game.settings.get(HOPE_MODULE, 'showAwardButtonFailedRolls');
  const alreadyAwardedOnMessage = message.flags?.[HOPE_MODULE]?.failureHopeAwarded;
  const canAwardOnMessage = ['attack', 'save'].includes(flags.type);
  if (showAwardButtonFailedRolls && canAwardOnMessage && !alreadyAwardedOnMessage) {
    const awardButton = $(`<button class="hope-actions-award-chat button">Award Hope</button>`);
    const awardArea = $html.find('.card-buttons').first();
    if (awardArea.length) {
      awardArea.append(awardButton);
    } else {
      const contentArea = $html.find('.message-content');
      (contentArea.length ? contentArea : $html).append(awardButton);
    }

    awardButton.on('click', async () => {
      await awardActorHope(actor, 1, 'manual roll award');
      await message.setFlag(HOPE_MODULE, 'failureHopeAwarded', true);
      awardButton.prop('disabled', true);
    });
  }

  const supportedHopeRollTypes = ['abilityTest', 'attack', 'save'];
  if (!supportedHopeRollTypes.includes(flags.type)) return;
  if (message.flags?.[HOPE_MODULE]?.spentHope) return;
  if (isNaturalOneMessage(message)) return;
  if (getActorHope(actor) <= 0) return;

  const button = $(`<button class="hope-actions-chat button">${game.i18n.localize('HOPE.ChatButtonLabel')}</button>`);
  const buttonArea = $html.find('.card-buttons').first();
  if (buttonArea.length) {
    buttonArea.append(button);
  } else {
    const contentArea = $html.find('.message-content');
    (contentArea.length ? contentArea : $html).append(button);
  }

  button.on('click', async () => {
    const currentHope = getActorHope(actor);
    if (currentHope <= 0) {
      return ui.notifications.warn(game.i18n.localize('HOPE.SpendNoHope'));
    }
    const pendingAction = await promptHopeAction(actor, currentHope, message);
    if (!pendingAction) return;
    await applyHopeActionToMessage(actor, message, pendingAction);
  });
}

async function promptHopeAction(actor, currentHope, message) {
  const baseTotal = getMessageRollTotal(message);
  const baseFormula = getMessageRollFormula(message);

  return new Promise(resolve => {
    let availableHope = currentHope;
    let pendingAdd = 0;
    let previewTotal = baseTotal;
    let rerollResult = null;

    const content = `
      <p>${game.i18n.localize('HOPE.SpendDialogText')}</p>
      <p>Original result: <strong>${baseTotal}</strong></p>
      <p>Preview result: <strong id="hope-preview">${previewTotal}</strong></p>
      <p>Current Hope: <span id="hope-current-amount">${availableHope}</span>/${game.settings.get(HOPE_MODULE, 'maxHope')}</p>
      <p>Pending add: <span id="hope-pending-amount">${pendingAdd}</span></p>
      <div class="form-group">
        <label>${game.i18n.localize('HOPE.SpendAddLabel')}</label>
        <input id="hope-add" type="number" min="1" max="${availableHope}" value="1" style="width: 100%;" />
      </div>
    `;

    const dialog = new Dialog({
      title: game.i18n.localize('HOPE.SpendDialogTitle'),
      content,
      buttons: {
        reroll: {
          label: 'Reroll',
          callback: async (html) => {
            if (rerollResult) {
              ui.notifications.warn('Reroll is already selected.');
              return false;
            }
            if (availableHope < 3) {
              ui.notifications.warn('Not enough Hope for a reroll.');
              return false;
            }
            if (!baseFormula) {
              ui.notifications.warn('Unable to reroll this roll.');
              return false;
            }
            availableHope -= 3;
            rerollResult = await new Roll(baseFormula).roll();
            previewTotal = rerollResult.total + pendingAdd;
            html.find('#hope-current-amount').text(availableHope);
            html.find('#hope-add').attr('max', availableHope).val(1);
            html.find('#hope-preview').text(previewTotal);
            return false;
          }
        },
        add: {
          label: 'Add',
          close: false,
          callback: async (html) => {
            const amount = Number(html.find('#hope-add').val()) || 1;
            if (amount <= 0) {
              ui.notifications.warn('Please enter a valid amount.');
              return false;
            }
            if (amount > availableHope) {
              ui.notifications.warn('You cannot spend more Hope than you have.');
              return false;
            }
            availableHope -= amount;
            pendingAdd += amount;
            const currentBase = rerollResult ? rerollResult.total : baseTotal;
            previewTotal = currentBase + pendingAdd;
            html.find('#hope-current-amount').text(availableHope);
            html.find('#hope-pending-amount').text(pendingAdd);
            html.find('#hope-preview').text(previewTotal);
            html.find('#hope-add').attr('max', availableHope).val(1);
            return false;
          }
        },
        done: {
          label: 'Done',
          callback: () => {
            if (rerollResult || pendingAdd > 0) {
              resolve({
                type: 'modify',
                rerollSelected: Boolean(rerollResult),
                reroll: rerollResult,
                addAmount: pendingAdd
              });
            } else {
              resolve(null);
            }
          }
        }
      },
      default: 'done',
      close: () => resolve(null)
    });

    dialog.render(true);
  });
}

function getMessageRollFormula(message) {
  return message?.rolls?.[0]?.formula || '';
}

function getMessageRollTotal(message) {
  return Number(message?.rolls?.[0]?.total ?? 0);
}

function rollHasNaturalOne(roll) {
  return roll?.dice?.some(die =>
    die.faces === 20 && die.results?.some(r => r.result === 1 && (r.active ?? true))
  );
}

async function applyHopeActionToMessage(actor, message, pendingAction) {
  const formula = getMessageRollFormula(message);
  const baseTotal = getMessageRollTotal(message);
  const rerollSelected = Boolean(pendingAction.rerollSelected);
  const addAmount = Number(pendingAction.addAmount) || 0;
  const hopeCost = (rerollSelected ? 3 : 0) + addAmount;

  if (getActorHope(actor) < hopeCost) {
    ui.notifications.warn('You do not have enough Hope for this action.');
    return;
  }

  if (rerollSelected && !formula) {
    ui.notifications.warn('Hope Actions could not determine the original roll formula.');
    return;
  }

  await spendActorHope(actor, hopeCost);

  const reroll = pendingAction.reroll;
  let currentRollTotal = baseTotal;

  if (rerollSelected) {
    if (rollHasNaturalOne(reroll)) {
      await adjustActorHope(actor, hopeCost);
      await reroll.toMessage({
        speaker: ChatMessage.getSpeaker({actor}),
        flavor: `${actor.name} rolled a natural 1 on the Hope reroll. Hope was refunded.`
      });
      return;
    }
    currentRollTotal = reroll.total;
  }

  if (addAmount > 0) {
    const updatedTotal = currentRollTotal + addAmount;
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({actor}),
      content: `<p>${actor.name} spends ${hopeCost} Hope (+${addAmount}${rerollSelected ? ', including reroll' : ''}) and changes the result from ${currentRollTotal} to ${updatedTotal}.</p>`
    });
    return;
  }

  if (rerollSelected && reroll) {
    await reroll.toMessage({
      speaker: ChatMessage.getSpeaker({actor}),
      flavor: `${actor.name} spends 3 Hope to reroll.`
    });
  }
}
