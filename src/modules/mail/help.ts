export const mailHelp = {
  text: `Triez votre propre boîte Gmail Google Workspace selon vos règles personnelles. Les règles, e-mails, conversations, aperçus et rapports sont privés.

*1. Connecter ou déconnecter Gmail*
• courrier connecter : ouvrir l’autorisation Google dans le navigateur, puis confirmer dans Slack que la boîte affichée est la vôtre. Le lien expire après 10 minutes.
• Menu → Tri des e-mails → Connexion Gmail : consulter la connexion actuelle.
• courrier déconnecter : demander une déconnexion à confirmer séparément. Elle retire les identifiants actifs et annule les aperçus en attente, tout en conservant vos règles. La révocation de l’autorisation Google se fait dans votre compte Google.

*2. Consulter, créer, modifier et retirer des règles*
• courrier règles ou Gérer les règles : lire les conditions, expéditeurs, libellés et actions approuvés.
• courrier modèles : proposer les modèles Urgent et Lettres d’information, et expliquer comment créer une association de projet. Urgent et les règles de projets gardent les messages en boîte de réception ; les lettres d’information peuvent aller à la corbeille, avec des exclusions pour factures, reçus, alertes de sécurité, notifications transactionnelles, messages urgents et projets. Les associations de projets demandent des adresses d’expéditeurs explicites.
• Ajouter une règle / Modifier : obtenir les instructions, puis décrire la condition, l’action et les exceptions après courrier. Exemple : courrier Applique le libellé Projets/Alpha aux messages de alex@example.com et conserve-les dans ma boîte de réception.
• Pour modifier : courrier Modifie ma règle de lettres d’information pour exclure les annonces de produits. Pour retirer, utilisez Retirer dans Gérer les règles, ou décrivez précisément la règle à supprimer.
L’assistant présente une proposition avec des exemples. Ajouter, modifier ou supprimer une règle nécessite votre approbation séparée sous 24 heures.

*3. Préparer et approuver un tri*
• courrier trier ou Trier la boîte de réception : analyser les 100 derniers messages individuels de la boîte de réception, avec votre connexion et vos règles approuvées. Le lancement peut utiliser l’IA ; aucune modification Gmail n’a lieu avant confirmation de l’aperçu.
• L’aperçu explique les libellés proposés, l’archivage et les déplacements à la corbeille. Plusieurs libellés sont possibles ; une règle explicite de conservation prévaut sur l’archivage. Les contradictions non résolues laissent le message inchangé.
• Examiner les messages / Détails : lire les messages et leurs raisons, page par page. Inclure la proposition ou Laisser sans modification pour les éléments qui demandent votre décision, puis Confirmer les modifications ; Annuler abandonne l’aperçu.
Un aperçu expire après 24 heures et devient invalide si les règles ou la connexion changent. Approbations en attente rouvre les propositions et aperçus encore valides, sans prolonger leur délai ni recommencer l’analyse. Un lancement pendant un tri en cours indique la demande existante.

*4. Consulter les rapports, corriger et annuler des changements*
• courrier rapport : consulter un traitement conservé ; Dernier rapport dans le menu ouvre le plus récent traitement terminé.
• courrier détails <identifiant-du-traitement> [page] : consulter ses messages, décisions et effets ; la première page vaut 0.
• Correction : courrier Pour le message <identifiant-du-message> du traitement <identifiant-du-traitement>, retire le libellé Urgent et conserve-le dans ma boîte de réception. La correction reçoit son propre aperçu à confirmer ; un changement de règle future exige une autre approbation.
• Annuler ce traitement dans un rapport : inverser uniquement les changements enregistrés par l’assistant sur les messages encore dans l’état attendu. Les messages modifiés depuis sont ignorés. Une action incertaine doit être vérifiée dans Gmail ; elle n’est pas répétée automatiquement. Les libellés nouvellement créés ne sont pas supprimés par l’annulation.
Les règles persistent jusqu’à leur retrait. Les conversations et traces de traitements sont normalement conservées 30 jours lorsque le module est activé. L’annulation dépend aussi de la disponibilité du message dans Gmail.

*Coûts et limites*
Le langage naturel et la classification sémantique utilisent le budget OpenAI partagé. Aide, menus, lecture des règles, modèles, rapports enregistrés, confirmations et annulation ne nécessitent pas de génération payante. Envoyez budget pour consulter l’usage.
Le tri est à la demande. L’envoi d’e-mails, la suppression définitive, l’ouverture de liens et le traitement de pièces jointes ne sont pas proposés.
Préfixe conseillé : courrier ; mail et les commandes anglaises restent compatibles. courrier aide (ou courrier seul) rouvre ce guide.`,
};
