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
  Hooks.on('renderChatMessage', renderHopeActionButton);
});

function getMessageActor(message) {
  return message.getAssociatedActor?.()
    ?? ChatMessage.getSpeakerActor(message.speaker)
    ?? game.actors.get(message.speaker?.actor)
    ?? null;
}

function normalizeRollType(type) {
  const value = String(type ?? '').toLowerCase();
  if (['abilitytest', 'abilitycheck', 'check', 'ability', 'skill'].includes(value)) return 'abilityTest';
  if (['save', 'savingthrow'].includes(value)) return 'save';
  if (value === 'attack') return 'attack';
  return '';
}

function getMessageRollType(message) {
  const rawType = message.flags?.dnd5e?.roll?.type
    ?? message.getFlag?.('dnd5e', 'roll.type')
    ?? message.rolls?.[0]?.options?.type
    ?? message.rolls?.[0]?.options?.dnd5e?.type;
  return normalizeRollType(rawType);
}

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

  // Anchor to window-content so the control floats without consuming layout space.
  const $host = $root.find('.window-content').first().length
    ? $root.find('.window-content').first()
    : $root;
  if (!$host.length) return;

  const headerHeight = Number($root.find('.sheet-header').first().outerHeight() ?? 0);
  const topOffset = Math.max(headerHeight + 6, 8);

  // Avoid duplicate injection on partial re-renders.
  $root.find('.hope-actions-sheet').remove();
  $host.addClass('hope-actions-host');
  $host.css('--hope-sheet-top', `${topOffset}px`);

  const currentHope = getActorHope(actor);
  const maxHope = game.settings.get(HOPE_MODULE, 'maxHope');

  const control = $(
    `<div class="hope-actions-sheet">
      <span class="hope-actions-value">Hope <strong>${currentHope}</strong>/${maxHope}</span>
      ${(actor.isOwner || game.user.isGM) ? '<button class="hope-actions-award" type="button" title="Award 1 Hope" aria-label="Award 1 Hope">+1</button>' : ''}
    </div>`
  );

  $host.append(control);

  control.on('click', '.hope-actions-award', async () => {
    await awardActorHope(actor, 1, 'award');
  });

}

async function renderHopeActionButton(message, html) {
  const flags = message.flags?.dnd5e?.roll ?? {};
  const rollType = getMessageRollType(message) || normalizeRollType(flags.type);
  const actor = getMessageActor(message);
  const $html = html instanceof jQuery ? html : $(html);

  if (!actor) return;
  if ($html.find('.hope-actions-chat, .hope-actions-award-chat').length) return;
  const canManageHope = actor.isOwner || game.user.isGM;
  if (!canManageHope) return;

  const showAwardButtonFailedRolls = game.settings.get(HOPE_MODULE, 'showAwardButtonFailedRolls');
  const alreadyAwardedOnMessage = message.flags?.[HOPE_MODULE]?.failureHopeAwarded;
  const canAwardOnMessage = ['attack', 'save'].includes(rollType);
  const contentArea = $html.find('.message-content');
  const rowHost = contentArea.length ? contentArea : $html;
  let buttonRow = rowHost.find('.hope-actions-chat-row').first();
  if (!buttonRow.length) {
    buttonRow = $('<div class="hope-actions-chat-row"></div>');
    rowHost.append(buttonRow);
  }

  if (showAwardButtonFailedRolls && canAwardOnMessage && !alreadyAwardedOnMessage) {
    const awardButton = $(`<button class="hope-actions-award-chat button">Award Hope</button>`);
    buttonRow.append(awardButton);

    awardButton.on('click', async () => {
      await awardActorHope(actor, 1, 'manual roll award');
      await message.setFlag(HOPE_MODULE, 'failureHopeAwarded', true);
      awardButton.prop('disabled', true);
    });
  }

  const supportedHopeRollTypes = ['abilityTest', 'attack', 'save'];
  if (!supportedHopeRollTypes.includes(rollType)) return;
  if (message.flags?.[HOPE_MODULE]?.spentHope) return;
  if (isNaturalOneMessage(message)) return;
  if (getActorHope(actor) <= 0) return;

  const button = $(`<button class="hope-actions-chat button">${game.i18n.localize('HOPE.ChatButtonLabel')}</button>`);
  buttonRow.append(button);

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
  const maxHope = game.settings.get(HOPE_MODULE, 'maxHope');

  // Use a manually managed overlay instead of new Dialog() because Foundry V13's
  // ApplicationV2-based Dialog shim ignores `close: false` on button definitions.
  return new Promise(resolve => {
    let availableHope = currentHope;
    let pendingAdd = 0;
    let previewTotal = baseTotal;
    let rerollResult = null;
    let isRerolling = false;

    const $overlay = $(`
      <div id="hope-spend-overlay">
        <div class="hope-spend-dialog">
          <h3>${game.i18n.localize('HOPE.SpendDialogTitle')}</h3>
          <p class="notes">${game.i18n.localize('HOPE.SpendDialogText')}</p>
          <div class="hope-dialog-stats">
            <div><span class="hope-stat-label">Original</span><strong>${baseTotal}</strong></div>
            <div><span class="hope-stat-label">Preview</span><strong id="hope-preview">${previewTotal}</strong></div>
            <div><span class="hope-stat-label">Hope Left</span><span id="hope-current-amount">${availableHope}</span>/${maxHope}</div>
            <div><span class="hope-stat-label">Pending +</span><span id="hope-pending-amount">${pendingAdd}</span></div>
          </div>
          <div class="form-group">
            <label>${game.i18n.localize('HOPE.SpendAddLabel')}</label>
            <input id="hope-add" type="number" min="1" max="${availableHope}" value="1" />
          </div>
          <div class="hope-dialog-buttons">
            <button class="hope-dialog-btn" data-action="reroll">Reroll <em>(3 Hope)</em></button>
            <button class="hope-dialog-btn" data-action="add">Add</button>
            <button class="hope-dialog-btn primary" data-action="done">Done</button>
            <button class="hope-dialog-btn secondary" data-action="cancel">Cancel</button>
          </div>
        </div>
      </div>
    `);

    const closeDialog = (result) => { $overlay.remove(); resolve(result); };

    const refreshDialogState = () => {
      $overlay.find('#hope-current-amount').text(availableHope);
      $overlay.find('#hope-pending-amount').text(pendingAdd);
      $overlay.find('#hope-preview').text(previewTotal);
      $overlay.find('#hope-add').attr('max', Math.max(availableHope, 0)).val(1);
    };

    $overlay.on('click', '[data-action="reroll"]', async () => {
      if (rerollResult) { ui.notifications.warn('Reroll is already selected.'); return; }
      if (isRerolling) { return; }
      if (availableHope < 3) { ui.notifications.warn('Not enough Hope for a reroll.'); return; }
      if (!baseFormula) { ui.notifications.warn('Unable to reroll this roll.'); return; }
      isRerolling = true;
      const $rerollButton = $overlay.find('[data-action="reroll"]');
      const previousLabel = $rerollButton.text();
      $rerollButton.prop('disabled', true).text('Rerolling...');

      availableHope -= 3;
      refreshDialogState();

      try {
        const roll = new Roll(baseFormula);
        rerollResult = typeof roll.evaluate === 'function'
          ? await roll.evaluate({async: true})
          : await roll.roll();

        previewTotal = Number(rerollResult.total ?? 0) + pendingAdd;
        refreshDialogState();
        $rerollButton.text('Rerolled').prop('disabled', true);
      } catch (err) {
        availableHope += 3;
        refreshDialogState();
        $rerollButton.text(previousLabel).prop('disabled', false);
        console.error('Hope Actions reroll failed:', err);
        ui.notifications.error('Reroll failed. Please try again.');
      } finally {
        isRerolling = false;
      }
    });

    $overlay.on('click', '[data-action="add"]', () => {
      const amount = Number($overlay.find('#hope-add').val()) || 1;
      if (amount <= 0) { ui.notifications.warn('Please enter a valid amount.'); return; }
      if (amount > availableHope) { ui.notifications.warn('You cannot spend more Hope than you have.'); return; }
      availableHope -= amount;
      pendingAdd += amount;
      const currentBase = rerollResult ? rerollResult.total : baseTotal;
      previewTotal = currentBase + pendingAdd;
      refreshDialogState();
    });

    $overlay.on('click', '[data-action="done"]', () => {
      if (rerollResult || pendingAdd > 0) {
        closeDialog({ type: 'modify', rerollSelected: Boolean(rerollResult), reroll: rerollResult, addAmount: pendingAdd });
      } else {
        closeDialog(null);
      }
    });

    $overlay.on('click', '[data-action="cancel"]', () => closeDialog(null));

    // Click outside the dialog box to cancel.
    $overlay.on('click', (e) => {
      if ($(e.target).is('#hope-spend-overlay')) closeDialog(null);
    });

    $('body').append($overlay);
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
