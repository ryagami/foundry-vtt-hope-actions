# Hope Actions Tracker

A Foundry VTT module for D&D 5E that tracks a custom resource called Hope.

## Features

- Players start with 0 Hope.
- Hope is capped at 5.
- If a player would gain Hope while at 5, they instead lose all Hope and keep only the result of 1d4.
- Players can gain Hope on failed attack rolls and failed saving throws (automatic and/or chat button, configurable), once per turn.
- The GM can manually award Hope from the actor sheet.
- Players can spend Hope on attack rolls, ability checks, and saving throws:
  - Spend any amount of Hope for +1 per Hope spent.
  - Spend 3 Hope to reroll the next d20.

## Installation

Place this folder in your Foundry `Data/modules` directory and enable it in the Module Settings.

## Settings

- **Auto-trigger Hope prompt for ability checks**: When enabled, players with Hope will be prompted to spend it before rolling ability checks.
- **Maximum Hope**: The maximum amount of Hope a character can have before overflow occurs (default 5).
- **Auto-award Hope on failed attacks/saves**: Automatically grant 1 Hope on failed attack rolls and failed saving throws.
- **Show chat Award Hope button on failed attacks/saves**: Adds an Award Hope button to failed attack/save chat messages.
- Players can also toggle auto-trigger per character on their actor sheet.

## Notes

This module adds a small Hope panel to D&D 5E character sheets and hooks into chat messages to award Hope on misses/fails.
