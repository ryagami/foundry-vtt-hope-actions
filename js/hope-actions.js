const HOPE_MODULE = 'foundry-vtt-hope-actions';
const HOPE_FLAG = 'hope';
const HOPE_PENDING_FLAG = 'pendingHope';
const HOPE_AWARD_TURN_FLAG = 'lastAutoAwardTurn';

Hooks.once('init', () => {
  console.log('Hope Actions | Initializing module');
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
        const reroll = wrapped(...args);
        this.results = reroll.results;
        this._total = reroll._total ?? reroll.total;
        this._evaluated = true;
      }
      return result;
    }, 'WRAPPER');

    libWrapper.register(HOPE_MODULE, 'CONFIG.Actor.documentClass.prototype.rollAbilityTest', async function(wrapped, abilityId, options = {}) {
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
        const reroll = originalDieRoll.call(this, options);
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
      ActorClass.prototype.rollAbilityTest = async function (abilityId, options = {}) {
        options = await applyPendingHopeToOptions(this, options);
        return originalAbilityTest.call(this, abilityId, options);
      };

      const originalSave = ActorClass.prototype.rollAbilitySave;
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
  Hooks.on('preCreateChatMessage', handleChatMessageHopeAward);
  Hooks.on('preUpdateCombat', handleCombatTurnChange);
});

function clampHope(value) {
  return Math.min(Math.max(Number(value) || 0, 0), 5);
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
  if (current >= 5) {
    const roll = await new Roll('1d4').roll({ async: true });
    const newValue = roll.total;
    await setActorHope(actor, newValue);
    const content = `<p>${actor.name} already had 5 Hope and drops to ${newValue} Hope (${roll.formula}).</p>`;
    ChatMessage.create({
      speaker: ChatMessage.getSpeaker({actor: actor.id}),
      content
    });
    return newValue;
  }

  const next = clampHope(current + amount);
  await setActorHope(actor, next);

  const content = `<p>${actor.name} gains ${amount} Hope${reason ? ` (${reason})` : ''}. Current Hope: ${next}/5.</p>`;
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

function renderActorSheetHopeControls(app, html, data) {
  const actor = app.actor;
  if (!actor) return;

  const currentHope = getActorHope(actor);
  const pending = actor.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG);
  const pendingText = pending ? `Pending: ${pending.type === 'reroll' ? 'd20 reroll' : `+${pending.amount}`}` : '';

  const control = $(
    `<div class="hope-actions-sheet" style="margin-top: 0.25rem; display: flex; align-items: center; gap: 0.5rem;">
      <span><strong>Hope</strong> ${currentHope}/5</span>
      <span>${pendingText}</span>
      ${actor.isOwner ? '<button class="hope-actions-use button">Use Hope</button>' : ''}
      ${game.user.isGM ? '<button class="hope-actions-award button">Award Hope</button>' : ''}
    </div>`
  );

  html.find('.sheet-header').prepend(control);

  control.on('click', '.hope-actions-award', async () => {
    await awardActorHope(actor, 1, 'DM award');
  });

  control.on('click', '.hope-actions-use', async () => {
    if (currentHope <= 0) {
      return ui.notifications.warn(game.i18n.localize('HOPE.SpendNoHope'));
    }
    const pendingAction = await promptHopeAction(actor, currentHope);
    if (!pendingAction) return;
    await actor.setFlag(HOPE_MODULE, HOPE_PENDING_FLAG, pendingAction);
    const message = pendingAction.type === 'reroll'
      ? `${actor.name} will spend 3 Hope to reroll the next d20.`
      : `${actor.name} will spend ${pendingAction.amount} Hope to add +${pendingAction.amount} to the next roll.`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content: `<p>${message}</p>`});
  });
}

async function promptHopeAction(actor, currentHope) {
  return new Promise(resolve => {
    const content = `
      <p>${game.i18n.localize('HOPE.SpendDialogText')}</p>
      <p>Current Hope: ${currentHope}/5</p>
      <div class="form-group">
        <label>${game.i18n.localize('HOPE.SpendAddLabel')}</label>
        <input id="hope-add" type="number" min="0" max="${currentHope}" value="0" style="width: 100%;" />
      </div>
    `;

    new Dialog({
      title: game.i18n.localize('HOPE.SpendDialogTitle'),
      content,
      buttons: {
        reroll: {
          label: 'Reroll',
          callback: async (html) => {
            if (currentHope < 3) {
              ui.notifications.warn('Not enough Hope for a reroll.');
              return resolve(null);
            }
            await spendActorHope(actor, 3);
            resolve({type: 'reroll', amount: 3});
          }
        },
        add: {
          label: 'Add',
          callback: async (html) => {
            const amount = Number(html.find('#hope-add').val()) || 0;
            if (amount <= 0) {
              ui.notifications.warn('Please enter a valid amount.');
              return resolve(null);
            }
            if (amount > currentHope) {
              ui.notifications.warn('You cannot spend more Hope than you have.');
              return resolve(null);
            }
            await spendActorHope(actor, amount);
            resolve({type: 'add', amount});
          }
        },
        done: {
          label: 'Done',
          callback: () => resolve(null)
        }
      },
      default: 'done'
    }).render(true);
  });
}

function patchDnd5eRolls() {
  const ActorClass = CONFIG.Actor.documentClass;
  const ItemClass = CONFIG.Item.documentClass;
  if (!ActorClass || !ItemClass) return;

  const originalAbilityTest = ActorClass.prototype.rollAbilityTest;
  ActorClass.prototype.rollAbilityTest = async function (abilityId, options = {}) {
    options = await applyPendingHopeToOptions(this, options);
    return originalAbilityTest.call(this, abilityId, options);
  };

  const originalSave = ActorClass.prototype.rollAbilitySave;
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

async function applyPendingHopeToOptions(actor, options = {}) {
  const pending = actor.getFlag(HOPE_MODULE, HOPE_PENDING_FLAG);
  if (!pending) return options;
  await actor.unsetFlag(HOPE_MODULE, HOPE_PENDING_FLAG);

  if (pending.type === 'add') {
    options.modifiers = (options.modifiers || 0) + pending.amount;
    const content = `<p>${actor.name} spends ${pending.amount} Hope to add +${pending.amount} to this roll.</p>`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content});
  }

  if (pending.type === 'reroll') {
    game[HOPE_MODULE].nextD20Reroll = true;
    const content = `<p>${actor.name} spends 3 Hope to reroll the next d20.</p>`;
    ChatMessage.create({speaker: ChatMessage.getSpeaker({actor: actor.id}), content});
  }

  return options;
}
