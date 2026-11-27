# Module Factures

Le pilote utilise `production@mayasquad.com` et les e-mails de facturation Anthropic portant le libellé Gmail `Factures outils`. Les fournisseurs continuent d’utiliser leurs adresses habituelles. Le module recherche les e-mails de la période définie en heure de Paris et vérifie leurs expéditeurs et objets. Les opérations de collecte et de synthèse sont déterministes.

## Consulter les factures

Dans un DM avec Mayassistant, ouvrez **Menu → Factures** ou envoyez `factures mois dernier`, `factures ce mois` ou `factures 2026-11`. En DM, une mention comme `@Mayassistant factures Quels reçus as-tu trouvés pour 2026-11 ?` donne le même relevé en texte. Seuls les utilisateurs Slack configurés accèdent aux résultats. Un lien vers Gmail conserve les permissions de la boîte d’origine.

Le résultat identifie les e-mails qui contiennent un PDF, les liens Stripe reconnus et les documents à vérifier. Il indique aussi pour quels fournisseurs configurés aucun mail n’a été trouvé. Le rapprochement avec les prélèvements et la collecte depuis les espaces clients restent manuels.

## Utiliser ma boîte Courrier

Lorsque Courrier et Factures sont activés, ouvrez **Menu → Factures → Utiliser ma boîte Courrier → Choisir un libellé** dans votre DM. Choisissez un libellé de votre boîte Gmail déjà connectée à Courrier. Seuls les messages de ce libellé alimentent votre relevé Courrier, avec leur date, leur expéditeur et un lien au message d’origine. Placez uniquement les factures que vous voulez consulter dans ce libellé.

Vous pouvez consulter le mois en cours ou le mois dernier, changer de libellé ou choisir **Retirer ma boîte** depuis le même écran. Un renommage conserve la sélection. Après suppression du libellé, déconnexion de Courrier ou remplacement de la connexion, choisissez à nouveau un libellé. Les commandes de période et les mentions telles que `@Mayassistant factures pour 2026-11 ?` privilégient votre boîte Courrier après la sélection d’un libellé. La boîte de production reste accessible par ses entrées propres dans le menu.

Courrier renouvelle son accès avec le client OAuth déjà configuré. La sélection se fait entièrement dans Slack. La lecture des factures personnelles reste en DM et utilise des appels Gmail de lecture. Les récapitulatifs planifiés et l’archivage Drive concernent la boîte de production. Voir [la décision sur l’autorisation Courrier](adr/0014-factures-courrier.md).

## Configuration

Pour utiliser uniquement les boîtes Courrier, activez `factures` et `mail` et gardez la configuration Courrier existante. Les variables OAuth Factures, les expéditeurs et les destinataires Slack du pilote ci-dessous servent à la boîte de production.

1. Créez le libellé `Factures outils` dans la boîte existante. Filtrez les expéditeurs Anthropic vérifiés et les objets de facturation. Pour tester un mois passé, appliquez aussi le libellé aux messages existants qui correspondent.
2. Autorisez un client Google OAuth à accéder à cette boîte avec la portée `https://www.googleapis.com/auth/gmail.readonly` et un jeton de renouvellement obtenu avec un consentement hors connexion (`access_type=offline`). Conservez les informations client et le jeton dans l’environnement privé du serveur. Le module compare l’identité renvoyée par Gmail à la boîte configurée avant de lister les messages. Le jeton permet la lecture de la boîte et le code limite chaque recherche au libellé. Les autorisations du module Courrier sont indépendantes. [Consentement OAuth hors connexion](https://developers.google.com/identity/protocols/oauth2/web-server#offline)
3. Ajoutez `factures` à `ENABLED_MODULES` en conservant les autres modules. Renseignez `FACTURES_GOOGLE_CLIENT_ID`, `FACTURES_GOOGLE_CLIENT_SECRET`, `FACTURES_GOOGLE_REFRESH_TOKEN`, `FACTURES_ANTHROPIC_SENDERS` (adresses exactes, séparées par des virgules) et `FACTURES_SLACK_USER_IDS` (identifiants Slack autorisés, séparés par des virgules). Les valeurs par défaut de `FACTURES_GMAIL_ADDRESS` et `FACTURES_GMAIL_LABEL` correspondent au pilote. Utilisez un client interne approuvé dans Google Workspace et connectez le compte choisi par le titulaire.
4. Le premier essai se fait à la demande. Une fois les destinations confirmées, `FACTURES_MONTHLY_ENABLED=true` programme un récap du mois précédent le 5 à 9 h, heure de Paris. Si l’activation intervient après le 5, le planificateur amorce le récap du mois précédent au démarrage. Slack envoie un message individuel à chaque destinataire configuré. Une reprise après une réponse Slack incertaine ne renvoie pas le même récapitulatif.

Pour ajouter des fournisseurs, remplacez le réglage du pilote par `FACTURES_PROVIDERS`, un tableau JSON. Chaque entrée donne le nom de suivi, les adresses exactes vérifiées et des fragments distinctifs de l’objet. Ajoutez aussi ces mails au filtre Gmail. Un même expéditeur peut servir plusieurs fournisseurs si chaque objet identifie une seule règle.

```json
[
  {"name":"Anthropic","senders":["anthropic-receipts@example.com"],"subjectMatches":["Your receipt from Anthropic"]},
  {"name":"Autre fournisseur","senders":["comptabilite@example.com"],"subjectMatches":["Votre facture fournisseur"]}
]
```

### Archivage Drive facultatif

Renseignez ensemble `FACTURES_DRIVE_FOLDER_ID` et `FACTURES_DRIVE_SERVICE_ACCOUNT_JSON`. Activez l’API Drive pour ce compte de service et limitez son accès au dossier autorisé dans un Drive partagé. Vérifiez avant activation que les destinataires Slack disposent des droits nécessaires sur le dossier. Le module ne change pas le partage. Le récapitulatif planifié copie les PDF joints admissibles de 10 Mio maximum et fournit leurs liens Drive. La consultation à la demande n’écrit aucun fichier. Les documents derrière un portail restent accessibles depuis le mail source. Les copies se dédupliquent sur le contenu dans le dossier configuré et les reprises conservent le même identifiant Drive.

## Vérification après activation

Ouvrez le module avec un utilisateur autorisé et demandez un mois avec un reçu connu. Comparez le résultat au libellé Gmail. Testez le même accès avec un autre utilisateur pour vérifier le refus. Activez ensuite le récapitulatif si souhaité et vérifiez la réception du DM privé et, si configuré, l’ouverture du PDF archivé. Le démarrage crée les tables nécessaires automatiquement. [Déploiement de Mayassistant](deployment.md#activation-du-module-factures)
