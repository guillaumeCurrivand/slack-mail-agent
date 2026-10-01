/** Display labels only; saved rules, plans and run states keep their machine values. */
const states: Record<string, string> = {
  keep: 'conserver', archive: 'archiver', trash: 'corbeille', scanning: 'analyse en cours',
  preview: 'aperçu', applying: 'application en cours', done: 'terminé', cancelled: 'annulé',
  undoing: 'annulation en cours', undone: 'annulé', pending: 'en attente', prepared: 'préparé',
  applied: 'appliqué', skipped: 'ignoré', conflict: 'conflit', unknown: 'incertain', undo_prepared: 'annulation préparée',
};
export const stateLabel = (value: string) => states[value] ?? value;
