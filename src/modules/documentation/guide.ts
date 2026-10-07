import { projectHelp, catalogHelp, componentHelp, hostHelp, hostingHelp, toolHelp } from './help.js';
import { inventoryQueryHelp } from './inventory-query.js';
import { lifecycleHelp } from './lifecycle.js';

export const documentationHelp = {
  text: `Consultez et maintenez l’inventaire partagé de l’entreprise. Les fiches et leur historique sont communs à l’espace Slack ; vos questions, contexte de projet et confirmations restent privés en DM. Aucune connexion Gmail n’est nécessaire.

*1. Comprendre les six types de fiches*
• Projets : noms, alias, descriptions, dépôts, liens de documentation et notes. documentation projets liste les projets ; documentation projet Alpha ouvre une fiche par identifiant, nom exact ou alias.
• Technologies : catalogue de technologies réutilisables et leurs catégories/notes. documentation technologies ; documentation technologie React.
• Composants : parties d’un projet, leur type et leurs technologies. documentation composants Alpha ; documentation composant <cible>. Un composant appartient à un projet fixe.
• Hébergeurs/services : services partagés, rôle, coût mensuel, devise et notes. documentation hébergeurs ; documentation hébergeur OVH. Un coût inconnu ne signifie pas zéro ; le coût du service partagé n’est pas facturé par projet.
• Hébergements : rattachement d’un composant à un service, environnement, référence de compte, URL et instructions d’accès. documentation hébergements <composant> ; documentation hébergement <identifiant>. Le composant parent est fixe.
• Outils : catégorie, utilisation, référent, usage pour toute l’entreprise et projets associés. documentation outils ; documentation outil Slack. Un référent est descriptif ; il n’accorde aucun droit et ne reçoit pas de notification.
Ouvrir et les liens de relation permettent de naviguer entre les fiches. Les listes proposent Précédent/Suivant ; les commandes de liste acceptent une page commençant à 0. Les liens de ressources enregistrés sont cliquables, mais leur contenu n’est pas lu par l’assistant.

*2. Poser des questions, rechercher et compter*
• Questions : documentation où Alpha est-il hébergé ? ; documentation quelles technologies utilise ce projet ? ; documentation quels projets utilisent React et OVH sur leurs composants ? ; documentation combien de projets utilisent React ? ; documentation quels outils sont utilisés par toute l’entreprise ?
L’interprétation en langage naturel utilise le budget IA partagé. La réponse s’appuie sur les fiches actuelles et les relations explicites ; les informations inconnues ne sont pas inventées. Votre contexte de projet privé expire après 30 minutes.
• documentation rechercher <JSON> et documentation compter <JSON> : filtrer gratuitement les fiches par relations et valeurs exactes, ou compter les correspondances distinctes. La rubrique Rechercher et compter explique les champs, le périmètre d’un même composant et les exemples. La pagination relit les données ; un changement d’inventaire redémarre la consultation.

*3. Créer et modifier une fiche*
• Commande structurée : documentation créer projet {"name":"Alpha","description":"Application équipe"}.
• Modification ciblée : documentation modifier projet Alpha {"description":"Nouvelle description","notes":null}.
• Langage naturel : documentation crée un projet nommé Alpha ; documentation remplace la description de ce projet par Application équipe.
Décrivez une seule fiche, une cible exacte et des valeurs explicites. Choisissez ci-dessous la rubrique du type de fiche pour voir les commandes, champs autorisés et contraintes. Les clés JSON restent techniques. Une référence manquante exige une création séparée ; les relations ne créent pas d’autres fiches automatiquement.
L’assistant affiche les valeurs proposées et demande votre confirmation séparée dans ce DM sous 24 heures. Rien ne change avant confirmation. Seuls les champs fournis sont remplacés, même si une autre personne les a modifiés depuis la proposition ; les autres champs sont conservés. null rend un champ facultatif inconnu ; une valeur vide exprime une valeur vide. Les identifiants, métadonnées et historique ne sont pas modifiables.

*4. Archiver et restaurer*
• documentation archives : parcourir les fiches archivées.
• documentation archiver projet Alpha ; documentation restaurer projet Alpha : proposer l’opération pour une fiche, avec confirmation séparée sous 24 heures.
Archiver conserve l’identifiant, les relations et l’historique. Les références archivées sont signalées. Une fiche archivée doit être restaurée avant modification ; la restauration ne renouvelle pas une ancienne proposition de modification. Ces opérations ne suppriment pas définitivement les fiches et ne restaurent pas les anciennes valeurs de champs.

*5. Lire l’historique*
• documentation historique : consulter l’historique partagé.
• documentation historique projet Alpha, ou Historique sur une fiche : examiner ses changements, auteurs, dates et valeurs avant/après. Pour les autres types, indiquez leur type et leur cible exacte ; un hébergement exige son identifiant.
L’historique métier est conservé avec l’inventaire, y compris après archivage. Les confirmations et boutons restent personnels ; relire une proposition ne prolonge pas sa validité.

*Coûts, accès et limites*
Menus, fiches, relations, historique, requêtes JSON, créations/modifications structurées, archivage et restauration n’utilisent pas d’IA. Les questions et mutations en langage naturel utilisent le budget OpenAI partagé et gardent les mêmes confirmations. Envoyez budget pour consulter l’usage.
Stockez seulement les références de comptes et liens/instructions vers un gestionnaire de mots de passe, jamais des mots de passe ou clés API. L’assistant ne lit pas les documents derrière les liens et n’effectue pas d’opération auprès des hébergeurs. Les modifications groupées, changements de schéma, suppression définitive et restauration de valeurs historiques ne sont pas proposés.
L’import depuis des sources externes est un outil opérateur hors ligne avec revue préalable ; ce n’est pas une commande Slack.
documentation aide (ou documentation seul) rouvre ce guide. Les commandes anglaises restent compatibles ; les rubriques ci-dessous détaillent chaque parcours.`,
  topics: [
    { label: 'Projets : commandes et champs', text: projectHelp },
    { label: 'Technologies : commandes et champs', text: catalogHelp },
    { label: 'Composants : commandes et champs', text: componentHelp },
    { label: 'Hébergeurs : commandes et champs', text: hostHelp },
    { label: 'Hébergements : commandes et champs', text: hostingHelp },
    { label: 'Outils : commandes et champs', text: toolHelp },
    { label: 'Rechercher et compter', text: inventoryQueryHelp + '\n\nExemple de comptage gratuit : documentation compter {"target":"project","filters":[{"kind":"technology","selector":"React"}],"scope":"project"}. Pour des contraintes qui doivent être satisfaites par un seul composant, utilisez "scope":"same-component".' },
    { label: 'Archiver et restaurer', text: lifecycleHelp },
  ],
};
