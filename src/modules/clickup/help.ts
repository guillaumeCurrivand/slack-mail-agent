export const clickupHelp = {
  text: `Consultez en privé les tâches et sous-tâches qui vous sont directement assignées dans l’espace ClickUp Mayasquad, avec votre compte personnel. Ce module consulte les tâches sans les modifier.

*1. Connecter votre compte*
• clickup connecter : autoriser l’accès à Mayasquad dans le navigateur, puis confirmer l’identité affichée dans Slack. Le lien est à usage unique et expire après 10 minutes ; la confirmation Slack expire après 24 heures.
• Menu → ClickUp : consulter l’état de votre connexion et accéder aux tâches et filtres. Changer de compte rouvre l’autorisation ; la nouvelle connexion doit être confirmée séparément.
Le compte et son accès à l’espace sont vérifiés. Un compte ClickUp déjà connecté par un autre utilisateur Slack ne peut pas être réutilisé.

*2. Lire vos tâches assignées*
• clickup tâches ou le bouton de consultation des tâches : récupérer vos tâches avec la sélection de statuts enregistrée.
Une tâche ou sous-tâche est incluse si votre compte figure directement parmi ses assignés, même avec d’autres assignés. Les éléments archivés sont exclus. Une affectation uniquement à une équipe ne suffit pas.
Le tableau présente les informations de tâche, son statut, son emplacement, sa date d’échéance et un lien pour l’ouvrir dans ClickUp. Les échéances sont des dates au format français, selon Europe/Paris.
Précédent/Suivant parcourent la consultation enregistrée. Les résultats expirent après 24 heures, dépendent de la connexion d’origine et nécessitent un accès toujours valide. Actualiser ou clickup tâches récupère une nouvelle liste ; Réessayer relance une récupération incomplète. Un résultat incomplet vide ne prouve pas l’absence de tâches. Un lancement pendant une récupération en cours indique la demande existante.

*3. Choisir les statuts visibles*
• clickup statuts : ouvrir votre filtre personnel de noms de statuts, commun à tout l’espace Mayasquad.
• Ajouter / Retirer : enregistrer immédiatement les choix. Utilisez l’option dédiée pour inclure les statuts terminés ; Réinitialiser revient au filtre par défaut. Fermer conserve les choix déjà enregistrés.
Les statuts fermés/terminés sont exclus par défaut. Le filtre compare les noms de statuts et conserve vos préférences entre les consultations et reconnexions. La liste signale les choix devenus indisponibles et les découvertes incomplètes. Actualiser les statuts renouvelle le catalogue ; Réessayer poursuit sa découverte si elle est incomplète.
Exemple : choisissez les statuts de travail qui vous intéressent avec clickup statuts, puis renvoyez clickup tâches. Un changement de filtre n’altère pas les résultats déjà enregistrés : chaque consultation garde son filtre d’origine.

*4. Déconnecter ClickUp*
• clickup déconnecter : proposer une déconnexion à confirmer séparément dans votre DM. Elle supprime les identifiants actifs, tentatives de connexion et résultats enregistrés. Vos préférences de statuts sont conservées.
Vous pouvez aussi révoquer l’autorisation depuis ClickUp.

*Coûts et limites*
Aucun appel d’IA ni connexion Gmail n’est nécessaire. Vous voyez uniquement les éléments accessibles à votre compte dans l’espace configuré ; la récupération peut être incomplète si ClickUp ne permet pas de tout lire.
Utilisez les commandes et menus décrits ici ; les demandes libres en langage naturel ne sont pas prises en charge. Ce module ne crée pas de tâche, ne change pas son statut et ne modifie pas ses assignés. Le traitement de maintenance et le passage à to build appartiennent au module Développement, avec son autorisation propre.
clickup aide (ou clickup seul) rouvre ce guide. Équivalents anglais : clickup connect, clickup tasks, clickup statuses, clickup disconnect, clickup help.`,
};
