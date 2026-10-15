'use strict';
const assert = require('node:assert/strict');

function integerEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  assert.ok(Number.isInteger(value) && value >= minimum && value <= maximum, `${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

function choiceEnvironment(name, choices) {
  const value = process.env[name];
  assert.ok(value === undefined || choices.includes(value), `${name} must be one of ${choices.join(', ')}`);
  return value;
}

function configuration() {
  const cases = integerEnvironment('CR_PROPERTY_CASES', 6, 1, 16);
  return {
    seed: integerEnvironment('CR_PROPERTY_SEED', 0xc3a710, 0, 0xffffffff),
    cases,
    steps: integerEnvironment('CR_PROPERTY_STEPS', 160, 1, 240),
    case: integerEnvironment('CR_PROPERTY_CASE', -1, -1, cases - 1),
    adapter: choiceEnvironment('CR_PROPERTY_ADAPTER', ['chrome', 'browser']),
    machine: choiceEnvironment('CR_PROPERTY_MACHINE', ['access', 'delivery'])
  };
}

function random(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
  return {
    integer(limit) { assert.ok(Number.isInteger(limit) && limit > 0); return Math.floor(next() * limit); },
    pick(values) { return values[this.integer(values.length)]; }
  };
}

function caseSeed(seed, index) {
  return (seed + Math.imul(index, 0x9e3779b9)) >>> 0;
}

function replayCommand(config, adapter, machine, index) {
  return `CR_PROPERTY_SEED=${config.seed} CR_PROPERTY_CASES=${config.cases} CR_PROPERTY_STEPS=${config.steps} CR_PROPERTY_CASE=${index} CR_PROPERTY_ADAPTER=${adapter} CR_PROPERTY_MACHINE=${machine} node --test extension/src/tests/lifecycle-properties.test.js`;
}

async function runCases(config, adapter, machine, execute) {
  let transitions = 0;
  for (let index = 0; index < config.cases; index++) {
    if (config.case !== -1 && config.case !== index) continue;
    const seed = caseSeed(config.seed, index), sequence = [];
    const step = async (command, apply) => {
      sequence.push(structuredClone(command));
      await apply(command);
      transitions++;
    };
    try {
      await execute({ random: random(seed), step, steps: config.steps });
    } catch (error) {
      throw new Error(`${error.message}\nProperty failure: seed=${config.seed}, caseSeed=${seed}, case=${index}, adapter=${adapter}, machine=${machine}, step=${sequence.length - 1}\nReplay: ${replayCommand(config, adapter, machine, index)}\nSequence: ${JSON.stringify(sequence)}`, { cause: error });
    }
  }
  return transitions;
}

module.exports = { configuration, random, caseSeed, replayCommand, runCases };
