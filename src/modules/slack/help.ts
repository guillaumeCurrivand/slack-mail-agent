export const slackHelp = {
  text: `Retrouvez les demandes qui vous concernent et auxquelles vous n’avez pas répondu, dans vos canaux Slack sélectionnés. Vos sélections et résultats sont privés et indépendants de Gmail.

*1. Choisir les canaux à examiner*
• slack canaux ou Menu → Messages Slack sans réponse → Choisir les canaux : parcourir les canaux publics et privés accessibles à vous et au bot.
• Ajouter / Retirer : enregistrer immédiatement votre sélection personnelle. Précédent/Suivant parcourent la liste dans le même message.
Le module commence sans sélection. Un canal devenu inaccessible reste sélectionné avec une explication ; vous pouvez le retirer. La sélection n’affecte pas les destinations Yousign.

*2. Lancer une recherche*
• slack sans-réponse ou Chercher les messages sans réponse : lancer une recherche à la demande sur les 48 heures précédant votre commande.
La recherche repère les mentions directes, les correspondances avec vos noms de profil et les demandes que le contexte vous adresse. Une réponse ultérieure de votre part dans le fil retire l’ancienne demande ; une nouvelle demande dirigée vers vous dans ce fil peut être retenue.
Exemple : choisissez les canaux de vos projets, puis envoyez slack sans-réponse pour retrouver les demandes récentes restées en attente.
Un lancement pendant une recherche en cours indique la demande existante au lieu de recommencer l’analyse.

*3. Comprendre et parcourir les résultats*
Les résultats sont regroupés par canal, avec auteur, date, extrait et lien Ouvrir le message. Les demandes certaines figurent sous Messages sans réponse ; les demandes incertaines mais reliées à vous sous Vous concerne peut-être, avec une explication.
Précédent/Suivant relisent les résultats enregistrés sans nouvelle classification payante. L’accès aux canaux et la sélection sont revérifiés avant l’affichage des extraits. Relancez slack sans-réponse pour actualiser les résultats ou si un ancien résultat est indisponible.
Les canaux inaccessibles sont signalés et ignorés pour cette recherche. Les limites d’accès ou une analyse incomplète peuvent empêcher de trouver toutes les demandes.

*Coûts, accès et limites*
Choisir les canaux et lire les résultats enregistrés n’utilise pas d’IA. L’analyse contextuelle utilise le budget OpenAI partagé. Si le budget ou le fournisseur est indisponible, les correspondances directes restent affichées avec un avertissement de résultats incomplets.
Le bot et vous devez avoir accès aux canaux choisis. Le module consulte les messages ; il ne répond pas à votre place et n’envoie pas de relances. La recherche concerne les canaux sélectionnés, sans Gmail, et se lance à votre demande.
slack aide (ou slack seul) rouvre ce guide. Équivalents anglais : slack channels, slack unanswered, slack help.`,
};
