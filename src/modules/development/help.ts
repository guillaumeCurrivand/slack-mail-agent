export const developmentHelp = {
  text: `Analysez les tickets de maintenance ClickUp d’un projet, précisez leurs exigences dans Slack, puis autorisez un worker Cursor local à préparer et pousser une correction testée. Les projets et leur suivi sont accessibles aux membres de leur canal ; la configuration et les commandes ci-dessous passent par le DM.

*Parcours par boutons*
Envoyez menu → Développement → Projets et traitements → choisissez votre projet. Voir les traitements affiche une liste paginée ; Ouvrir donne le résultat complet, les vérifications, le ticket ClickUp et le commit éventuel. Actualiser relit le suivi sans démarrer de travail. Précédent/Suivant parcourent les pages ; les retours restent dans le même message. Le suivi repose sur les données enregistrées, pas sur un signal de présence du worker.
Ouvrir le canal Slack permet de partager un lien de ticket ; Ouvrir le ticket ClickUp permet de consulter ses informations et de sélectionner Ready for AI. Ce statut reste l’autorisation de modifier le code. Aide du module ouvre ce guide.
Suspendre le projet, Réactiver le projet et Relancer… ouvrent une confirmation séparée : vérifiez le projet, le ticket et les conséquences puis confirmez ou annulez. Une confirmation est personnelle, liée au DM, valable 24 heures et utilisable une seule fois. Les accès au canal et la configuration sont revérifiés. Réactiver peut libérer la file conservée et les tickets déjà Ready for AI ; suspendre laisse les travaux déjà démarrés terminer.
Les menus expirent après 30 jours : envoyez menu pour en ouvrir un nouveau. Si les accès Slack sont indisponibles, vérifiez les permissions puis actualisez. Aucun menu ni guide ne lance d’analyse Cursor.

*1. Configurer, consulter ou suspendre un projet*
Configurer un projet ouvre un modèle de commande, suspendu par défaut. Modifier la configuration préremplit les valeurs du projet. Copiez la commande dans le DM et saisissez les champs libres ; après enregistrement, revenez au projet pour le réactiver une fois le worker prêt. Ouvrir un écran ne change jamais le préfixe requis pour les messages suivants.
• development projets : lister les projets accessibles et leur état ; ouvrez un projet pour consulter son canal Slack, son dossier ClickUp et son skill.
• development configurer {"id":"alpha","name":"Alpha","channel":"C123ABC","folder":"123","repository":"https://github.com/organisation/alpha","skill":"maintenance"} : enregistrer un projet, ou remplacer sa configuration en reprenant son identifiant et ses champs.
id identifie le projet ; name est son nom ; channel désigne le canal ; folder le dossier ClickUp ; repository le dépôt ; skill la compétence de maintenance du worker. Vous et le bot devez accéder au canal actuel et au nouveau canal ; le dossier ClickUp doit être lisible.
Le champ facultatif enabled vaut true par défaut. Fournissez "enabled":false dans la configuration complète pour suspendre les nouveaux traitements. Le worker doit posséder une correspondance locale pour le projet, son dépôt et sa branche de maintenance ; cette installation relève de l’opérateur.

*2. Faire analyser un ticket et préciser la demande*
Publiez un lien de tâche ou sous-tâche ClickUp appartenant au dossier configuré dans le canal de projet. L’assistant lit le ticket et prépare une analyse. Tant que la demande n’est pas autorisée, vos réponses dans le fil Slack sont ajoutées aux commentaires ClickUp pour préciser les exigences.
Exemple : partagez le lien d’un bug dans le canal Alpha, puis répondez dans le fil avec le comportement attendu et la façon de reproduire le problème.
Quand les informations sont suffisantes, l’assistant vous invite à passer le ticket à Ready for AI. La publication du lien déclenche l’analyse, pas l’autorisation de modifier le code.

*3. Autoriser une correction et comprendre sa livraison*
Passez vous-même le ticket à Ready for AI dans ClickUp. Ce statut autorise le travail sur le projet activé ; l’assistant observe aussi les tickets ainsi autorisés sans nouveau lien Slack. Les exigences du ticket et de ses commentaires sont alors figées pour le traitement.
Le worker local doit être connecté. Il prépare la correction, exécute les vérifications et peut effectuer jusqu’à deux essais. En cas de succès, il pousse le commit testé sur la branche de maintenance configurée, passe le ticket à to build, puis ajoute un compte rendu dans ClickUp et Slack. Une erreur de publication apparaît dans le suivi et nécessite une vérification humaine.
Vous créez ensuite le PR/MR et gérez sa revue. Aucun PR/MR, fusion ou déploiement automatique n’est effectué par ce parcours.

*4. Consulter le suivi et relancer un traitement bloqué*
• development statut <identifiant-du-projet> : ouvrir le projet, ses problèmes de connexion et le bouton Voir les traitements ; Ouvrir affiche les identifiants, états, essais, résumés et vérifications.
• development relancer <identifiant-du-traitement> : relancer un traitement bloqué sans commit, avec les exigences déjà figées, ou relancer explicitement une publication incertaine déjà poussée. Le projet doit être actif et accessible.
Une publication incertaine relancée lit le ticket actuel et laisse le commit déjà poussé sur son ancienne branche. Le worker publie la nouvelle exécution sur la branche indiquée dans sa configuration locale. Ready for AI ne fait pas cette relance tout seul.
Pour changer les exigences d’un traitement bloqué sans commit, modifiez le ticket, changez son statut, attendez que la surveillance (environ une minute) observe cet autre statut, puis remettez Ready for AI. Un aller-retour trop rapide peut ne pas être observé.
Le bouton Relancer… est visible seulement pour un traitement relançable d’un projet actif. Il conserve l’analyse ou la correction d’origine : une analyse relancée n’autorise pas de correction. Une publication incertaine avec commit exige une vérification humaine avant de confirmer du nouveau travail. Les commandes écrites relancer/retry restent des autorisations immédiates ; les boutons ajoutent une étape de confirmation. Les doublons pendant une relance active ne créent pas de travail supplémentaire.

*Prérequis et coûts*
L’opérateur configure les accès Slack/ClickUp, le worker local, les dépôts, les skills et les services nécessaires aux tests. Le compte ClickUp de ce module est celui de l’intégration de maintenance ; il est distinct de votre connexion personnelle au module ClickUp.
Les appels Cursor sont facturés séparément du budget OpenAI de l’assistant ; budget ne les comptabilise pas. Lire ce guide ne lance ni analyse ni correction. Ready for AI constitue l’autorisation explicite du traitement de maintenance.
development aide (ou development seul) rouvre ce guide. Équivalents anglais : development projects, development configure <JSON>, development status <projet>, development retry <traitement>, development help.`,
};
