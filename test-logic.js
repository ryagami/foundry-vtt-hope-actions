// Test script for Hope Actions logic
// Run with: node test-logic.js

// Mock Foundry objects
global.game = {
    modules: { get: () => ({ active: false }) }, // No libWrapper
    system: { id: 'dnd5e' },
    combat: null
};

global.ui = {
    notifications: {
        warn: (msg) => console.log('Warning:', msg)
    }
};

global.ChatMessage = {
    create: (data) => console.log('ChatMessage:', data.content),
    getSpeaker: (obj) => ({ alias: 'Test Actor' })
};

global.Hooks = {
    once: () => {},
    on: () => {}
};

// Mock actor
const mockActor = {
    name: 'Test Actor',
    getFlag: function(module, flag) {
        this.flags = this.flags || {};
        return this.flags[flag] || null;
    },
    setFlag: function(module, flag, value) {
        this.flags = this.flags || {};
        this.flags[flag] = value;
        console.log(`Set ${flag} to ${value}`);
        return value;
    },
    unsetFlag: function(module, flag) {
        this.flags = this.flags || {};
        delete this.flags[flag];
        console.log(`Unset ${flag}`);
    }
};

// Load the module (simplified, without hooks)
const HOPE_MODULE = 'foundry-vtt-hope-actions';
const HOPE_FLAG = 'hope';
const HOPE_PENDING_FLAG = 'pendingHope';

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
        // Mock roll
        const roll = { total: Math.floor(Math.random() * 4) + 1, formula: '1d4' };
        const newValue = roll.total;
        await setActorHope(actor, newValue);
        console.log(`${actor.name} already had 5 Hope and drops to ${newValue} Hope (${roll.formula}).`);
        return newValue;
    }

    const next = clampHope(current + amount);
    await setActorHope(actor, next);
    console.log(`${actor.name} gains ${amount} Hope${reason ? ` (${reason})` : ''}. Current Hope: ${next}/5.`);
    return next;
}

// Tests
async function runTests() {
    console.log('Running Hope Actions Logic Tests...\n');

    // Test 1: Initial hope
    console.log('Test 1: Initial hope');
    console.log('Hope:', getActorHope(mockActor)); // Should be 0

    // Test 2: Set hope
    console.log('\nTest 2: Set hope to 3');
    await setActorHope(mockActor, 3);
    console.log('Hope:', getActorHope(mockActor)); // Should be 3

    // Test 3: Adjust hope
    console.log('\nTest 3: Adjust hope +2');
    await adjustActorHope(mockActor, 2);
    console.log('Hope:', getActorHope(mockActor)); // Should be 5

    // Test 4: Award when at max (should roll 1d4)
    console.log('\nTest 4: Award when at max');
    await awardActorHope(mockActor, 1);
    console.log('Hope:', getActorHope(mockActor)); // Should be random 1-4

    // Test 5: Spend hope
    console.log('\nTest 5: Spend 2 hope');
    await setActorHope(mockActor, 4); // Reset to 4
    const spent = await spendActorHope(mockActor, 2);
    console.log('Spent:', spent, 'Remaining:', getActorHope(mockActor)); // Should be 2 spent, 2 remaining

    // Test 6: Clamp
    console.log('\nTest 6: Clamp values');
    console.log('Clamp -1:', clampHope(-1)); // 0
    console.log('Clamp 10:', clampHope(10)); // 5
    console.log('Clamp 3:', clampHope(3)); // 3

    console.log('\nAll tests completed!');
}

runTests().catch(console.error);