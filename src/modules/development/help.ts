export const developmentHelp = {
  text: `Analysez les tickets de maintenance ClickUp d’un projet, précisez leurs exigences dans Slack, puis autorisez un worker Cursor local à préparer et pousser une correction testée. Les projets et leur suivi sont accessibles aux membres de leur canal ; la configuration et les commandes ci-dessous passent par le DM.

*1. Configurer, consulter ou suspendre un projet*
• development projets : lister les projets accessibles avec canal Slack, dossier ClickUp, skill et état.
• development configurer {"id":"alpha","name":"Alpha","channel":"C123ABC","folder":"123","repository":"https://github.com/organisation/alpha","skill":"maintenance"} : enregistrer un projet, ou remplacer sa configuration en reprenant son identifiant et ses champs.
id identifie le projet ; name est son nom ; channel désigne le canal ; folder le dossier ClickUp ; repository le dépôt ; skill la compétence de maintenance du worker. Vous et le bot devez accéder au canal actuel et au nouveau canal ; le dossier ClickUp doit être lisible.
Le champ facultatif enabled vaut true par défaut. Fournissez "enabled":false dans la configuration complète pour suspendre les nouveaux traitements. Le worker doit posséder une correspondance locale pour le projet, son dépôt et sa branche de maintenance ; cette installation relève de l’opérateur.

*2. Faire analyser un ticket et préciser la demande*
Publiez un lien de tâche ou sous-tâche ClickUp appartenant au dossier configuré dans le canal de projet. L’assistant lit le ticket et prépare une analyse. Tant que la demande n’est pas autorisée, vos réponses dans le fil Slack sont ajoutées aux commentaires ClickUp pour préciser les exigences.
Exemple : partagez le lien d’un bug dans le canal Alpha, puis répondez dans le fil avec le comportement attendu et la façon de reproduire le problème.
Quand les informations sont suffisantes, l’assistant vous invite à passer le ticket à Ready for AI. La publication du lien déclenche l’analyse, pas l’autorisation de modifier le code.

*3. Autoriser une correction et comprendre sa livraison*
Passez vous-même le ticket à Ready for AI dans ClickUp. Ce statut autorise le travail sur le projet activé ; l’assistant observe aussi les tickets ainsi autorisés sans nouveau lien Slack. Les exigences du ticket et de ses commentaires sont alors figées pour le traitement.
Le worker local doit être connecté. Il prépare la correction, exécute les vérifications et peut effectuer jusqu’à deux essais. En cas de succès, il pousse le commit testé sur la branche de maintenance configurée, ajoute un compte rendu dans ClickUp et Slack, puis passe le ticket à to build.
Vous créez ensuite le PR/MR et gérez sa revue. Aucun PR/MR, fusion ou déploiement automatique n’est effectué par ce parcours.

*4. Consulter le suivi et relancer un traitement bloqué*
• development statut <identifiant-du-projet> : consulter les traitements, leurs identifiants, états, essais, résumés et problèmes de connexion.
• development relancer <identifiant-du-traitement> : demander une nouvelle exécution d’un traitement bloqué admissible, avec les exigences déjà figées. Le projet doit être actif et accessible, et le traitement ne doit pas avoir de commit à réconcilier.
Pour changer les exigences, modifiez le ticket, changez son statut puis remettez Ready for AI. Une publication incertaine ou un commit déjà poussé doit être vérifié avant reprise ; une relance ne doit pas répéter le code déjà publié.

*Prérequis et coûts*
L’opérateur configure les accès Slack/ClickUp, le worker local, les dépôts, les skills et les services nécessaires aux tests. Le compte ClickUp de ce module est celui de l’intégration de maintenance ; il est distinct de votre connexion personnelle au module ClickUp.
Les appels Cursor sont facturés séparément du budget OpenAI de l’assistant ; budget ne les comptabilise pas. Lire ce guide ne lance ni analyse ni correction. Ready for AI constitue l’autorisation explicite du traitement de maintenance.
development aide (ou development seul) rouvre ce guide. Équivalents anglais : development projects, development configure <JSON>, development status <projet>, development retry <traitement>, development help.`,
};
