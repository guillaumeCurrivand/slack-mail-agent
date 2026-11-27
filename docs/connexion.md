# Module Connexion

Dans un DM avec Mayassistant, envoyez `connexion` ou choisissez **Menu → Connexion**. Le tableau affiche les comptes et autorisations de l’utilisateur, ainsi que les intégrations d’équipe accessibles. **Actualiser** relit les états enregistrés dans Mayassistant. Ces états ne constituent pas un test de disponibilité chez les fournisseurs.

| Application | Ce que permet **Ouvrir** |
| --- | --- |
| Gmail · Courrier | Connecter Gmail ou demander sa déconnexion. |
| ClickUp | Connecter ou changer de compte, ou demander sa déconnexion. |
| Gmail · Factures | Choisir, changer ou retirer le libellé autorisé dans Factures. Disponible lorsque Courrier et Factures sont actifs. |
| Gmail · Factures de production | Accéder aux relevés de la boîte dédiée si l’administrateur a autorisé l’utilisateur. |
| Google Sheets · Documentation | Ouvrir le classeur partagé configuré. |
| Yousign et HyperDX | Ouvrir le module pour gérer les canaux accessibles sous ses règles habituelles. |
| ClickUp et Cursor · Développement | Ouvrir les réglages de projet accessibles depuis Développement. |

Les intégrations d’équipe utilisent la configuration de l’administrateur. Les écrans des modules conservent leurs autorisations, parcours OAuth et confirmations. Connexion affiche la liste en DM, sans appel aux fournisseurs ou à l’IA.

Pour l’activer, ajoutez `connexion` à `ENABLED_MODULES` en gardant les modules existants. La liste suit les modules activés. [Déploiement et vérification](deployment.md#activation-du-module-connexion)

## Pilote du tableau interactif

Dans le DM, choisissez **Ouvrir le tableau interactif** ou envoyez `connexion tableau`. Cliquez sur la carte **Connexion · Tableau interactif** pour ouvrir le panneau latéral Slack. Le tableau présente les comptes sans couper les adresses, avec recherche, filtre **Accès** et **Ouvrir** sur chaque ligne. **Ouvrir** demande l’écran de gestion du module dans la même conversation. Les décisions et confirmations de ce module restent dans Slack. Le panneau expire au bout de cinq minutes. Rouvrez la carte pour poursuivre la consultation.

`connexion` ouvre le tableau natif. Pour ouvrir le panneau latéral, configurez [Work Object Previews](deployment.md#activation-du-pilote-du-tableau-interactif) dans Slack. Le panneau vérifie le propriétaire et le DM de la carte. Les données du tableau sont issues des états enregistrés au lancement de la carte. Envoyez `connexion tableau` de nouveau pour actualiser ces états.
