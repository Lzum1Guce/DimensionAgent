import { changeTranscript } from './transcript-scroll.js';

function syncNeighborGrouping(transcript) {
  const rows = [...transcript.querySelectorAll('.gmsg:not(.is-speaking)')];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const sameSpeaker = Boolean(
      prev &&
      cur.dataset.speaker &&
      prev.dataset.speaker === cur.dataset.speaker &&
      !cur.querySelector('.gmsg-quote')
    );
    cur.classList.toggle('is-grouped', sameSpeaker);
  }
}

/** HTTP history and live messages share an identity and append-only sequence. */
export function insertGroupMessage(transcript, message, createRow) {
  const rows = [...transcript.querySelectorAll('.gmsg')];
  const existing = message.messageId && rows.find(row => row.dataset.messageId === message.messageId);
  if (existing) return existing;
  const row = createRow();
  if (message.messageId) row.dataset.messageId = message.messageId;
  if (Number.isSafeInteger(message.messageSeq)) row.dataset.messageSeq = String(message.messageSeq);
  const next = Number.isSafeInteger(message.messageSeq) && rows.find(item => Number(item.dataset.messageSeq) > message.messageSeq);
  changeTranscript(transcript, () => {
    transcript.insertBefore(row, next || null);
    syncNeighborGrouping(transcript);
  });
  return row;
}
