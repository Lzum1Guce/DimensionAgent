import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COPLAY_PROTOCOL_VERSION,
  VALID_COPLAY_MOODS,
  CoPlayError,
  CoPlaySession,
  GomokuAdapter,
  validateBridgePolicy,
  validateHoldKeyAction,
  normalizeReaction,
} from '../runtime/coplay-protocol.mjs';

test('validateBridgePolicy enforces loopback-only single-port LAN safety', () => {
  const ok = validateBridgePolicy({
    targetHost: '127.0.0.1',
    targetPort: 25565,
    explicitUserConsent: true,
    idleTimeoutSec: 900,
  });
  assert.equal(ok.targetHost, '127.0.0.1');
  assert.equal(ok.targetPort, 25565);
  assert.equal(ok.outboundInternetAllowed, false);

  assert.throws(
    () => validateBridgePolicy({ targetHost: '8.8.8.8', targetPort: 25565, explicitUserConsent: true }),
    (e) => e instanceof CoPlayError && e.code === 'DISALLOWED_HOST'
  );
  assert.throws(
    () => validateBridgePolicy({ targetHost: '127.0.0.1', targetPort: 18788, explicitUserConsent: true }),
    (e) => e instanceof CoPlayError && e.code === 'DISALLOWED_PORT'
  );
  assert.throws(
    () => validateBridgePolicy({ targetHost: '127.0.0.1', targetPort: 25565, explicitUserConsent: false }),
    (e) => e instanceof CoPlayError && e.code === 'CONSENT_REQUIRED'
  );
});

test('validateHoldKeyAction bounds key syntax and durationMs (50..2000ms)', () => {
  assert.deepEqual(validateHoldKeyAction({ key: 'ArrowRight', durationMs: 350 }), {
    op: 'hold_key',
    key: 'ArrowRight',
    durationMs: 350,
  });
  assert.throws(() => validateHoldKeyAction({ key: 'a; rm -rf /', durationMs: 200 }), { code: 'INVALID_KEY' });
  assert.throws(() => validateHoldKeyAction({ key: 'Return', durationMs: 20 }), { code: 'INVALID_DURATION' });
  assert.throws(() => validateHoldKeyAction({ key: 'Return', durationMs: 5000 }), { code: 'INVALID_DURATION' });
});

test('normalizeReaction clamps invalid moods to neutral and aligns with 16-mood set', () => {
  assert.equal(VALID_COPLAY_MOODS.length, 16);
  const valid = normalizeReaction({ mood: 'playful', speech: '这一手我早就防着啦！', intensity: 0.9 }, 'ai-gemini');
  assert.equal(valid.mood, 'playful');
  assert.equal(valid.speakTts, true);

  const fallback = normalizeReaction({ mood: 'nonexistent_mood', speech: '' }, 'ai-claude');
  assert.equal(fallback.mood, 'neutral');
  assert.equal(fallback.speakTts, false);
});

test('CoPlaySession + GomokuAdapter enforces turns, takeover pause, victory and recap export', () => {
  const adapter = new GomokuAdapter({ size: 9, blackSeat: 'human', whiteSeat: 'bot-grok' });
  const session = new CoPlaySession({
    sessionId: 'test-gomoku-1',
    gameId: 'gomoku',
    channel: 'structured_table',
    adapter,
    seats: [
      { seatId: 'human', kind: 'human', displayName: '玩家' },
      { seatId: 'bot-grok', kind: 'bot', botId: 'ai-grok', displayName: 'Grok' },
    ],
  });

  // Out-of-turn move must be rejected
  assert.throws(() => session.submitAction('bot-grok', { r: 4, c: 4 }), { code: 'NOT_YOUR_TURN' });

  // Human plays (4,0), then takeover pauses Bot
  session.submitAction('human', { r: 4, c: 0 });
  session.setHumanTakeover(true);
  assert.throws(() => session.submitAction('bot-grok', { r: 3, c: 0 }), { code: 'HUMAN_TAKEOVER_ACTIVE' });
  session.setHumanTakeover(false);

  // Play to a 5-in-a-row win for human
  const botMoves = [{ r: 3, c: 0 }, { r: 3, c: 1 }, { r: 3, c: 2 }, { r: 3, c: 3 }];
  const humanMoves = [{ r: 4, c: 1 }, { r: 4, c: 2 }, { r: 4, c: 3 }, { r: 4, c: 4 }];
  let lastRes;
  for (let i = 0; i < 4; i++) {
    session.submitAction('bot-grok', botMoves[i], { mood: 'serious', speech: `看我堵这一步 #${i + 1}` });
    lastRes = session.submitAction('human', humanMoves[i]);
  }
  assert.equal(lastRes.outcome.finished, true);
  assert.equal(lastRes.outcome.winnerSeatId, 'human');
  assert.throws(() => session.submitAction('bot-grok', { r: 0, c: 0 }), { code: 'SESSION_FINISHED' });

  const recap = session.exportRecap();
  assert.equal(recap.protocolVersion, COPLAY_PROTOCOL_VERSION);
  assert.equal(recap.turnCount, 9);
  assert.equal(recap.reactions.length, 4);
});
