import { appendTranscript, changeTranscript, atTranscriptEnd } from './transcript-scroll.js';

/** Each request owns its thoughts; concurrent members and later requests never clear one another. */
export function createThoughtStream({ getTranscript, nameOf = () => '', visible = () => true }) {
  const turns = new Map();
  const ensure = (from) => {
    let turn = turns.get(from);
    if (!turn) {
      const box = document.createElement('details'); box.className = 'think-chip is-live'; box.open = true;
      const summary = document.createElement('summary');
      const body = document.createElement('div'); body.className = 'think-chip-body';
      const reasoning = document.createElement('pre'); reasoning.className = 'think-reasoning'; reasoning.hidden = true;
      body.appendChild(reasoning); box.append(summary, body);
      turn = { box, summary, body, reasoning, text: '', steps: [], started: Date.now(), from, following: true };
      body.addEventListener('scroll', () => {
        if (box.open && body.clientHeight) turn.following = atTranscriptEnd(body);
      }, { passive: true });
      box.addEventListener('toggle', () => {
        if (box.open && turn.following) body.scrollTop = body.scrollHeight;
      });
      turns.set(from, turn);
    }
    return turn;
  };
  const paint = (turn, done = false) => {
    const transcript = visible() ? getTranscript() : null;
    changeTranscript(transcript, () => {
      const who = nameOf(turn.from);
      const label = turn.text.trim() ? '思考过程' : '执行过程';
      turn.summary.textContent = `${who ? `${who} · ` : ''}${label}${done ? ` · ${Math.max(1, Math.round((Date.now() - turn.started) / 1000))} 秒` : ' · 进行中'}`;
      turn.box.classList.toggle('is-live', !done);
      if (transcript && turn.box.parentNode !== transcript) appendTranscript(transcript, turn.box);
    });
  };
  const think = (from, delta) => {
    if (!delta) return;
    const turn = ensure(from);
    changeTranscript(visible() ? getTranscript() : null, () => {
      const follow = turn.box.open && turn.body.clientHeight ? atTranscriptEnd(turn.body) : turn.following;
      turn.text += String(delta);
      turn.reasoning.textContent = turn.text; turn.reasoning.hidden = false;
      paint(turn);
      turn.following = follow;
      if (follow && turn.box.open) turn.body.scrollTop = turn.body.scrollHeight;
    });
  };
  const process = (from, text) => {
    if (!String(text || '').trim()) return;
    const turn = ensure(from);
    if (turn.steps.at(-1) === text) return;
    turn.steps.push(text);
    changeTranscript(visible() ? getTranscript() : null, () => {
      const follow = turn.box.open && turn.body.clientHeight ? atTranscriptEnd(turn.body) : turn.following;
      const step = document.createElement('details'); step.className = 'think-proc';
      const title = document.createElement('summary'); title.textContent = String(text).split('\n')[0].slice(0, 120);
      const detail = document.createElement('pre'); detail.textContent = text;
      step.append(title, detail); turn.body.appendChild(step); paint(turn);
      turn.following = follow;
      if (follow && turn.box.open) turn.body.scrollTop = turn.body.scrollHeight;
    });
  };
  const settle = (from) => {
    const turn = turns.get(from);
    if (!turn) return;
    turns.delete(from);
    paint(turn, true); // Keep both the content and the reader's expanded/collapsed choice.
  };
  return { think, process, settle, finish: () => { for (const from of [...turns.keys()]) settle(from); } };
}
