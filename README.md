# Hope Actions Tracker

A Foundry VTT module for D&D 5E that tracks a custom resource called Hope.

## Features

- Players start with 0 Hope.
- Hope is capped at 5.
- If a player would gain Hope while at 5, they instead lose all Hope and keep only the result of 1d4.
- Players receive Hope automatically when they miss an attack or fail a saving throw, once per turn.
- The GM can manually award Hope from the actor sheet.
- Players can spend Hope before the next roll:
  - Spend any amount of Hope for +1 per Hope spent.
  - Spend 3 Hope to reroll the next d20.

## Installation

Place this folder in your Foundry `Data/modules` directory and enable it in the Module Settings.

## Settings

- **Auto-trigger Hope prompt for ability checks**: When enabled, players with non-zero Hope will be prompted to spend it before rolling an ability check.
- This setting is disabled by default, so Hope only spends when the player chooses to use it manually.

## Notes

This module adds a small Hope panel to D&D 5E character sheets and hooks into chat messages to award Hope on misses/fails.
