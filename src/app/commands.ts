/** Translate only command grammar, never record selectors, JSON or natural-language content. */
export function frenchCommand(module: string, text: string): string {
  const exact: Record<string, Record<string, string>> = {
    mail: { aide: 'help', bonjour: 'hello', salut: 'hi', trier: 'sort', 'trier ma boîte': 'sort', 'trier ma boite': 'sort', règles: 'rules', regles: 'rules', modèles: 'starters', modeles: 'starters', rapport: 'report', connecter: 'connect', 'connecter gmail': 'connect gmail', déconnecter: 'disconnect', deconnecter: 'disconnect' },
    slack: { aide: 'help', canaux: 'channels', 'sans réponse': 'unanswered', 'sans reponse': 'unanswered', 'sans-réponse': 'unanswered', 'sans-reponse': 'unanswered' },
    clickup: { aide: 'help', tâches: 'tasks', taches: 'tasks', statuts: 'statuses', connecter: 'connect', déconnecter: 'disconnect', deconnecter: 'disconnect' },
    yousign: { aide: 'help', canaux: 'channels', statut: 'status' },
    documentation: { aide: 'help', historique: 'history', archives: 'archived', archivés: 'archived' },
  };
  const normalized = text.toLowerCase();
  if (exact[module]?.[normalized]) return exact[module]![normalized]!;
  if (module === 'mail') return text.replace(/^détails(?=\s+[\w-]+(?:\s+\d+)?$)/i, 'details');
  if (module !== 'documentation') return text;
  // Match whole grammar words and leave the remainder byte-for-byte unchanged.
  const words: Record<string, string> = { projets: 'projects', projet: 'project', composants: 'components', composant: 'component', technologies: 'technologies', technologie: 'technology', hébergeurs: 'hosts', hebergeurs: 'hosts', hébergeur: 'host', hebergeur: 'host', hébergements: 'hosting', hebergements: 'hosting', hébergement: 'hosting-entry', hebergement: 'hosting-entry', outils: 'tools', outil: 'tool', historique: 'history', archives: 'archived', archivés: 'archived', créer: 'create', creer: 'create', modifier: 'edit', archiver: 'archive', restaurer: 'restore', rechercher: 'search', compter: 'count' };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  const first = match && words[match[1]!.toLowerCase()];
  if (!match || !first) return text;
  let rest = match[2] ?? '';
  if (['create', 'edit', 'archive', 'restore', 'history'].includes(first)) {
    rest = rest.replace(/^(\S+)(?=\s|$)/, token => words[token.toLowerCase()] ?? token);
    if (first === 'create' || first === 'edit' || first === 'archive' || first === 'restore') rest = rest.replace(/^hosting-entry(?=\s|$)/, 'hosting');
  }
  return `${first}${rest ? ` ${rest}` : ''}`;
}
