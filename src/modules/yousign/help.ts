export const yousignHelp = {
  text: `Recevez les événements de signature Yousign de l’entreprise dans les canaux Slack sélectionnés. La source Yousign et la liste de destinations sont partagées : vos changements de canaux concernent toute l’équipe.

*1. Gérer les destinations partagées*
• yousign canaux ou Menu → Yousign → Choisir les canaux : parcourir les canaux publics, privés et partagés avec l’extérieur accessibles à vous et au bot.
• Activer : autoriser immédiatement les futures notifications dans ce canal, sans confirmation supplémentaire. Les événements déjà reçus ne sont pas rattrapés.
• Retirer : désactiver la destination et annuler ses envois encore en attente. Un envoi déjà commencé peut aboutir ; les messages publiés restent en place.
La liste commence vide. Si aucune destination n’est active, les événements sont ignorés sans rattrapage ultérieur. Réactiver un canal ne relance pas les anciennes notifications. Les canaux auxquels vous n’avez pas accès sont masqués et leurs sélections sont conservées.
Précédent/Suivant parcourent les destinations dans le même message. Ces réglages sont indépendants de vos sélections personnelles Slack sans réponse.

*2. Recevoir les notifications automatiques*
Chaque événement authentifié reçu par l’intégration produit la même notification française dans les destinations actives lors de sa réception. Il n’y a pas de filtre par type d’événement ; les nouveaux noms d’événements sont également acceptés.
La notification contient les informations disponibles autorisées : événement, nom de demande ou identifiant de ressource, date et nom du signataire. Elle ne contient pas de document, adresse e-mail ou lien de signature.
Exemple : activez un canal de suivi, puis les futurs événements Yousign de l’entreprise y seront publiés automatiquement. Aucun lancement manuel n’est nécessaire.

*3. Consulter le statut et reprendre une livraison*
• yousign statut ou Statut : lire la dernière réception authentifiée et les livraisons visibles pour vos canaux, avec résultat, motif d’échec et prochain essai prévu. Actualiser relit l’état actuel ; Précédent/Suivant parcourent l’historique disponible.
Les échecs temporaires dont l’absence d’effet est certaine peuvent être réessayés automatiquement. Réessayer, lorsqu’il est proposé pour un échec définitif, demande un nouvel essai de la livraison concernée.
Une livraison incertaine n’est jamais renvoyée automatiquement. Examiner ouvre une confirmation séparée : vérifiez d’abord le canal, car Slack a peut-être déjà publié le message. Confirmer cette relance peut créer un doublon et exige votre confirmation dans ce DM sous 24 heures ; Annuler abandonne la proposition. Les accès et l’activation du canal sont revérifiés.
Les résumés terminés et traces de livraison sont normalement conservés 30 jours. Les incidents peuvent produire une alerte privée générique à l’administrateur configuré.

*Prérequis, coûts et limites*
L’intégration Yousign de l’entreprise doit être configurée par l’opérateur ; vous et le bot devez avoir accès aux destinations que vous gérez. La configuration et les statuts restent privés, tandis que les notifications sont visibles par les membres des canaux choisis, y compris externes s’il y en a.
Aucune IA ni connexion Gmail n’est nécessaire. Ce module n’envoie pas de demande de signature et ne télécharge pas de document. L’ordre des événements et la réception d’événements jamais acceptés par l’intégration ne sont pas garantis.
yousign aide (ou yousign seul) rouvre ce guide. Équivalents anglais : yousign channels, yousign status, yousign help.`,
};
