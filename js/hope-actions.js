const HOPE_MODULE = 'foundry-vtt-hope-actions';
const HOPE_FLAG = 'hope';
const HOPE_PENDING_FLAG = 'pendingHope';
const HOPE_AWARD_TURN_FLAG = 'lastAutoAwardTurn';
const HOPE_AUTO_TRIGGER_FLAG = 'autoTriggerEnabled';

Hooks.once('init', () => {
  console.log('Hope Actions | Initializing module');

  game.settings.register(HOPE_MODULE, 'autoTriggerAbilityChecks', {
    name: `${HOPE_MODULE}.settings.autoTriggerAbilityChecks.name`,
    hint: `${HOPE_MODULE}.settings.autoTriggerAbilityChecks.hint`,
    scope: 'world',
    config: true,
    type: Boolean,
    default: false
  });

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
});

Hooks.once('ready', () => {
  if (game.system?.id !== 'dnd5e') {
    ui.notifications.warn('Hope Actions requires the D&D 5E system.');
    return;
  }

  game[HOPE_MODULE] = {
    nextD20Reroll: false
  };

  if (game.modules.get('lib-wrapper')?.active) {
    // Use libWrapper for safer patching
    libWrapper.register(HOPE_MODULE, 'Die.prototype.roll', function(wrapped, ...args) {
      const result = wrapped(...args);
      if (this.faces === 20 && game[HOPE_MODULE]?.nextD20Reroll) {
        game[HOPE_MODULE].nextD20Reroll = false;
        let reroll = wrapped(...args);
        // Prevent crits: if reroll is 20, set to 19
        if (reroll.total === 20) {
          reroll.total = 19;
          reroll.results[reroll.results.length - 1].result = 19;
        }
        this.results = reroll.results;
        this._total = reroll._total ?? reroll.total;
        this._evaluated = true;
      }
      return result;
    }, 'WRAPPER');

    libWrapper.register(HOPE_MODULE, 'CONFIG.Actor.documentClass.prototype.rollAbilityTest', async function(wrapped, abilityId, options = {}) {
      const globalEnabled = game.settings.get(HOPE_MODULE, 'autoTriggerAbilityChecks');
      const actorEnabled = this.getFlag(HOPE_MODULE, HOPE_AUTO_TRIGGER_FLAG) ?? true; // Default to true if not set
      if (globalEnabled && actorEnabled && this.isOwner && getActorHope(this) > 0 && !this.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG)) {
        const pendingAction = await promptHopeAction(this, getActorHope(this));
        if (pendingAction) await this.setFlag(HOPE_MODULE, HOPE_PENDING_FLAG, pendingAction);
      }
      options = await applyPendingHopeToOptions(this, options);
      return wrapped(abilityId, options);
    }, 'WRAPPER');

    libWrapper.register(HOPE_MODULE, 'CONFIG.Actor.documentClass.prototype.rollAbilitySave', async function(wrapped, abilityId, options = {}) {
      options = await applyPendingHopeToOptions(this, options);
      return wrapped(abilityId, options);
    }, 'WRAPPER');

    libWrapper.register(HOPE_MODULE, 'CONFIG.Item.documentClass.prototype.rollAttack', async function(wrapped, options = {}) {
      const actor = this.actor;
      if (actor) {
        options = await applyPendingHopeToOptions(actor, options);
      }
      return wrapped(options);
    }, 'WRAPPER');
  } else {
    // Fallback to direct patching
    const originalDieRoll = Die.prototype.roll;
    Die.prototype.roll = function (options = {}) {
      const result = originalDieRoll.call(this, options);
      if (this.faces === 20 && game[HOPE_MODULE]?.nextD20Reroll) {
        game[HOPE_MODULE].nextD20Reroll = false;
        let reroll = originalDieRoll.call(this, options);
        // Prevent crits: if reroll is 20, set to 19
        if (reroll.total === 20) {
          reroll.total = 19;
          reroll.results[reroll.results.length - 1].result = 19;
        }
        this.results = reroll.results;
        this._total = reroll._total ?? reroll.total;
        this._evaluated = true;
      }
      return result;
    };

    const ActorClass = CONFIG.Actor.documentClass;
    const ItemClass = CONFIG.Item.documentClass;
    if (ActorClass && ItemClass) {
      const originalAbilityTest = ActorClass.prototype.rollAbilityTest;
      const originalSave = ActorClass.prototype.rollAbilitySave;
      ActorClass.prototype.rollAbilityTest = async function (abilityId, options = {}) {
        const globalEnabled = game.settings.get(HOPE_MODULE, 'autoTriggerAbilityChecks');
        const actorEnabled = this.getFlag(HOPE_MODULE, HOPE_AUTO_TRIGGER_FLAG) ?? true;
        if (globalEnabled && actorEnabled && this.isOwner && getActorHope(this) > 0 && !this.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG)) {
          const pendingAction = await promptHopeAction(this, getActorHope(this));
          if (pendingAction) await this.setFlag(HOPE_MODULE, HOPE_PENDING_FLAG, pendingAction);
        }
        options = await applyPendingHopeToOptions(this, options);
        return originalAbilityTest.call(this, abilityId, options);
      };

      ActorClass.prototype.rollAbilitySave = async function (abilityId, options = {}) {
        options = await applyPendingHopeToOptions(this, options);
        return originalSave.call(this, abilityId, options);
      };

      const originalAttack = ItemClass.prototype.rollAttack;
      ItemClass.prototype.rollAttack = async function (options = {}) {
        const actor = this.actor;
        if (actor) {
          options = await applyPendingHopeToOptions(actor, options);
        }
        return originalAttack.call(this, options);
      };
    }
  }

  Hooks.on('renderActorSheet5eCharacter', renderActorSheetHopeControls);
  Hooks.on('renderChatMessage', renderHopeActionButton);
  Hooks.on('preCreateChatMessage', handleChatMessageHopeAward);
  Hooks.on('preUpdateCombat', handleCombatTurnChange);
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
    const roll = await new Roll('1d4').roll({ async: true });
    const newValue = roll.total;
    await setActorHope(actor, newValue);
    const content = `<p>${actor.name} already had ${maxHope} Hope and drops to ${newValue} Hope (${roll.formula}).</p>`;
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({actor: actor.id}),
      content
    });
    return newValue;
  }

  const next = clampHope(current + amount);
  await setActorHope(actor, next);

  const content = `<p>${actor.name} gains ${amount} Hope${reason ? ` (${reason})` : ''}. Current Hope: ${next}/${maxHope}.</p>`;
  ChatMessage.create({
    speaker: ChatMessage.getSpeaker({actor: actor.id}),
    content
  });

  return next;
}

function getCurrentCombatTurnKey() {
  const combat = game.combat;
  if (!combat) return null;
  return `${combat.id}-${combat.turn}-${combat.round}`;
}

function hasAwardedThisTurn(actor) {
  const currentKey = getCurrentCombatTurnKey();
  if (!currentKey) return false;
  return actor.getFlag(HOPE_MODULE, HOPE_AWARD_TURN_FLAG) === currentKey;
}

async function markAwardedThisTurn(actor) {
  const currentKey = getCurrentCombatTurnKey();
  if (!currentKey) return;
  await actor.setFlag(HOPE_MODULE, HOPE_AWARD_TURN_FLAG, currentKey);
}

function handleCombatTurnChange(combat, changed, options, userId) {
  if ('turn' in changed || 'round' in changed) {
    // No stateful cleanup needed; turn tracking uses a turn key.
  }
}

async function handleChatMessageHopeAward(message, data, options, userId) {
  if (!data?.speaker) return;
  const actor = ChatMessage.getSpeakerActor(data.speaker);
  if (!actor) return;

  const flags = data.flags?.dnd5e?.roll ?? {};
  if (!['attack', 'save'].includes(flags.type)) return;
  if (hasAwardedThisTurn(actor)) return;

  const content = data.content || '';
  const failure = /(miss|failure|failed)/i.test(content);
  if (!failure) return;

  await awardActorHope(actor, 1, 'automatic reward');
  await markAwardedThisTurn(actor);
}

function isNaturalOneMessage(message) {
  const rolls = message.data?.rolls ?? message.rolls ?? [];
  return rolls.some(roll =>
    roll.dice?.some(die =>
      die.faces === 20 && die.results?.some(r => r.result === 1 && (r.active ?? true))
    )
  );
}

function renderActorSheetHopeControls(app, html, data) {
  const actor = app.actor;
  if (!actor) return;

  const currentHope = getActorHope(actor);
  const pending = actor.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG);
  const pendingText = pending ? `Pending: ${pending.type === 'reroll' ? 'd20 reroll' : `+${pending.amount}`}` : '';
  const autoTriggerEnabled = actor.getFlag(HOPE_MODULE, HOPE_AUTO_TRIGGER_FLAG) ?? true;

  const control = $(
    `<div class="hope-actions-sheet" style="margin-top: 0.25rem; display: flex; flex-direction: column; gap: 0.5rem;">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        <span><strong>Hope</strong> ${currentHope}/${game.settings.get(HOPE_MODULE, 'maxHope')}</span>
        <span>${pendingText}</span>
        ${actor.isOwner ? '<button class="hope-actions-use button">Use Hope</button>' : ''}
        ${(actor.isOwner || game.user.isGM) ? '<button class="hope-actions-award button">Award Hope</button>' : ''}
      </div>
      ${actor.isOwner ? `<label style="display: flex; align-items: center; gap: 0.5rem;"><input type="checkbox" class="hope-auto-trigger" ${autoTriggerEnabled ? 'checked' : ''} /> Auto-trigger Hope prompts</label>` : ''}
    </div>`
  );

  html.find('.sheet-header').prepend(control);

  control.on('click', '.hope-actions-award', async () => {
    await awardActorHope(actor, 1, 'award');
  });

  control.on('click', '.hope-actions-use', async () => {
    if (currentHope <= 0) {
      return ui.notifications.warn(game.i18n.localize('HOPE.SpendNoHope'));
    }
    const pendingAction = await promptHopeAction(actor, currentHope);
    if (!pendingAction) return;
    await actor.setFlag(HOPE_MODULE, HOPE_PENDING_FLAG, pendingAction);
  });

  control.on('change', '.hope-auto-trigger', async (event) => {
    const enabled = event.target.checked;
    await actor.setFlag(HOPE_MODULE, HOPE_AUTO_TRIGGER_FLAG, enabled);
  });
}

async function renderHopeActionButton(message, html) {
  const flags = message.data?.flags?.dnd5e?.roll ?? {};
  const actor = ChatMessage.getSpeakerActor(message.data.speaker);
  if (actor) {
    if (await handlePendingHopeRefund(actor, message)) return;
  }

  if (flags.type !== 'abilityTest') return;
  if (!actor) return;
  if (message.data?.flags?.[HOPE_MODULE]?.spentHope) return;
  if (isNaturalOneMessage(message)) return;
  if (getActorHope(actor) <= 0) return;
  if (!actor.isOwner && !game.user.isGM) return;
  if (actor.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG)) return;

  const button = $(`<button class="hope-actions-chat button">${game.i18n.localize('HOPE.ChatButtonLabel')}</button>`);
  const buttonArea = html.find('.card-buttons').length ? html.find('.card-buttons').first() : html;
  buttonArea.append(button);

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

async function handlePendingHopeRefund(actor, message) {
  const spentHope = message.data?.flags?.[HOPE_MODULE]?.spentHope;
  if (!spentHope) return false;

  if (isNaturalOneMessage(message)) {
    await refundHopeFromMessage(actor, message);
    return true;
  }

  return false;
}

async function refundHopeFromMessage(actor, message) {
  const refundAmount = message.data?.flags?.[HOPE_MODULE]?.spentHope;
  if (!refundAmount) return false;

  await adjustActorHope(actor, refundAmount);
  const content = `<p>${actor.name} gets ${refundAmount} Hope refunded because the roll was a natural 1.</p>`;
  ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content});
  return true;
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
      <p>Current Hope: <span id="hope-current-amount">${availableHope}</span>/5</p>
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
            if (pendingAdd > 0) {
              ui.notifications.warn('Finish or cancel adding before selecting Reroll.');
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
            rerollResult = await new Roll(baseFormula).roll({async: true});
            previewTotal = rerollResult.total;
            html.find('#hope-preview').text(previewTotal);
            return false;
          }
        },
        add: {
          label: 'Add',
          close: false,
          callback: async (html) => {
            if (rerollResult) {
              ui.notifications.warn('You cannot add Hope after rerolling.');
              return false;
            }
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
            previewTotal = baseTotal + pendingAdd;
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
            if (rerollResult) {
              resolve({type: 'reroll', amount: 3, reroll: rerollResult});
            } else if (pendingAdd > 0) {
              resolve({type: 'add', amount: pendingAdd});
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
  return message.rolls?.[0]?.formula || message.data?.rolls?.[0]?.formula || message.data?.flags?.dnd5e?.roll?.formula || '';
}

function getMessageRollTotal(message) {
  return Number(message.rolls?.[0]?.total ?? message.data?.rolls?.[0]?.total ?? 0);
}

async function applyHopeActionToMessage(actor, message, pendingAction) {
  const formula = getMessageRollFormula(message);
  if (!formula) {
    ui.notifications.warn('Hope Actions could not determine the original roll formula.');
    return;
  }

  if (pendingAction.type === 'add') {
    await spendActorHope(actor, pendingAction.amount);
    const reroll = await new Roll(`${formula} + ${pendingAction.amount}`).roll({async: true});
    await reroll.toMessage({
      speaker: ChatMessage.getSpeaker({actor: actor.id}),
      flavor: `${actor.name} spends ${pendingAction.amount} Hope to add +${pendingAction.amount}.`,
      flags: {[HOPE_MODULE]: {spentHope: pendingAction.amount}}
    });
    return;
  }

  if (pendingAction.type === 'reroll') {
    await spendActorHope(actor, pendingAction.amount);
    const reroll = pendingAction.reroll ?? await new Roll(formula).roll({async: true});
    await reroll.toMessage({
      speaker: ChatMessage.getSpeaker({actor: actor.id}),
      flavor: `${actor.name} spends ${pendingAction.amount} Hope to reroll.`,
      flags: {[HOPE_MODULE]: {spentHope: pendingAction.amount}}
    });
  }
}

async function applyPendingHopeToOptions(actor, options = {}) {
  const pending = actor.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG);
  if (!pending) return options;
  await actor.unsetFlag(HOPE_MODULE, HOPE_PENDING_FLAG);

  // The roll has not yet been evaluated here, so we cannot reliably detect a natural 1 yet.
  // Natural-1 refund handling happens later when the chat message is rendered.
  if (pending.type === 'add') {
    await spendActorHope(actor, pending.amount);
    options.flags = options.flags || {};
    options.flags[HOPE_MODULE] = {
      ...(options.flags[HOPE_MODULE] || {}),
      spentHope: pending.amount
    };
    let modifier = pending.amount;
    // Cap total at 19 to prevent crits
    if (options.modifiers) {
      const baseTotal = options.rolls?.[0]?.total || 0;
      const currentModifiers = Number(options.modifiers) || 0;
      const projectedTotal = baseTotal + currentModifiers + modifier;
      if (projectedTotal >= 20) {
        modifier = Math.max(0, 19 - (baseTotal + currentModifiers));
      }
    }
    options.modifiers = (options.modifiers || 0) + modifier;
    const content = `<p>${actor.name} spends ${pending.amount} Hope to add +${modifier} to this roll.</p>`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content});
  }

  if (pending.type === 'reroll') {
    await spendActorHope(actor, 3);
    options.flags = options.flags || {};
    options.flags[HOPE_MODULE] = {
      ...(options.flags[HOPE_MODULE] || {}),
      spentHope: 3
    };
    game[HOPE_MODULE].nextD20Reroll = true;
    const content = `<p>${actor.name} spends 3 Hope to reroll the next d20.</p>`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content});
  }

  return options;
}
