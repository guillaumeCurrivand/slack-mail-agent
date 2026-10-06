import { formatDate } from '../../core/presentation.js';
import { sourceLabel } from './presentation.js';
import type { Actor } from '../../core/identity.js';
import type { MenuPage } from '../../core/navigation.js';
import { escapeCardValue, type AgentMessage } from '../../core/slack.js';
import { recordTitle, recordName, type RecordKind } from './domain.js';
import { catalogHelp, componentHelp, hostHelp, hostingHelp, toolHelp, helpFor } from './help.js';
import { lifecycleButton, statusText, referenceLabel } from './lifecycle.js';
import type { DocumentationStore } from './store.js';
import { InventoryPresentation } from './presentation.js';

const literal = escapeCardValue;
const title = recordTitle;
const pluralFor = (kind: RecordKind) => ({ technology: "Technologies", component: "Composants", host: "Hébergeurs/services", hosting: "Hébergements", tool: "Outils" })[kind];
const exampleFor = (kind: RecordKind) => ({ technology: '{"notes":"Replacement"}', component: '{"type":"API","technologies":[]}', host: '{"role":"Compute"}', hosting: '{"environment":"staging","notes":null}', tool: '{"usage":"Replacement","referent":null}' })[kind];
const pages = (prefix: string, page: number, count: number) => [
  ...(page > 0 ? [{ label: "Précédent", page: `${prefix}_${page - 1}` }] : []),
  ...(page + 1 < count ? [{ label: "Suivant", page: `${prefix}_${page + 1}` }] : []),
];
async function pagedLookup<T extends { total: number }>(input: string, lookup: (selector: string) => Promise<T>) {
  let selector = input.trim(), result = await lookup(selector), page = '0';
  // A name ending in digits takes precedence over a trailing page number.
  const paged = /^([\s\S]+)\s+(\d{1,6})$/.exec(selector);
  if (!result.total && paged) { selector = paged[1]!.trim(); page = paged[2]!; result = await lookup(selector); }
  return { selector, result, page };
}
// Catalog navigation shares the Module's existing private menus and transport
// recovery. Every selector is re-read within the actor's workspace.
export class Catalog {
  constructor(private store: DocumentationStore) {}
  async page(actor: Actor, destination: string): Promise<MenuPage | undefined> {
    const presentation = new InventoryPresentation(this.store, actor);
    if (destination === 'addtechnology') return { kind: "Ajouter une technologie", text: catalogHelp, links: [{ label: "Retour", page: 'technologies_0' }] };
    if (destination === 'addtool') return { kind: "Ajouter un outil", text: toolHelp, links: [{ label: "Retour", page: 'tools_0' }] };
    if (destination === 'addhost') return { kind: "Ajouter un hébergeur/service", text: hostHelp, links: [{ label: "Retour", page: 'hosts_0' }] };
    const addHosting = /^addhosting_([^_]+)$/.exec(destination);
    if (addHosting) {
      const component = await this.store.record(actor, 'component', addHosting[1]!);
      return component ? { kind: "Ajouter un hébergement", text: `Composant : ${literal(recordName(component))} (${component.id})\nUtilisez documentation créer hébergement {\"componentId\":\"${component.id}\",\"serviceId\":\"<hébergeur/service existant>\",\"environment\":\"production\"}\n${hostingHelp}\n${hostHelp}`, links: [{ label: "Retour", page: `hostingentries_${component.id}_0` }] }
        : { kind: "Composant indisponible", text: "Ce composant est introuvable." };
    }
    const addComponent = /^addcomponent_([^_]+)$/.exec(destination);
    if (addComponent) {
      const project = await this.store.project(actor, addComponent[1]!);
      return project ? { kind: "Ajouter un composant", text: `Projet : ${literal(referenceLabel(project.fields.name, project))} (${project.id})\nUtilisez documentation créer composant {\"name\":\"Interface\",\"projectId\":\"${project.id}","type":"frontend","technologies":[]}\n${componentHelp}\n${catalogHelp}`, links: [{ label: "Retour", page: `components_${project.id}_0` }] }
        : { kind: "Projet indisponible", text: "Ce projet est introuvable." };
    }
    const list = /^(technologies|hosts|tools)_(\d{1,6})$/.exec(destination);
    const components = /^(components|techcomponents|hostingentries|hostentries|projecttools)_([^_]+)_(\d{1,6})$/.exec(destination);
    const lookup = /^cataloglookup_([^_]+)_(\d{1,6})$/.exec(destination);
    if (list || lookup || components) {
      const saved = lookup ? await this.store.savedLookup(actor, lookup[1]!) : undefined;
      if (lookup && !saved) return { kind: "Recherche indisponible", text: "Répétez la recherche exacte pour obtenir de nouveaux choix." };
      const kind: RecordKind = saved ? saved.destination.replace(/^history/, '') as RecordKind : list ? (list[1] === 'hosts' ? 'host' : list[1] === 'tools' ? 'tool' : 'technology') : components?.[1] === 'projecttools' ? 'tool' : components?.[1]?.includes('entries') ? 'hosting' : 'component';
      const label = title(kind), plural = pluralFor(kind);
      const parentId = ['components', 'projecttools'].includes(components?.[1] ?? '') ? components![2]! : null;
      const technologyId = components?.[1] === 'techcomponents' ? components[2]! : null;
      const parent = parentId ? await this.store.project(actor, parentId) : undefined;
      const technology = technologyId ? await this.store.record(actor, 'technology', technologyId) : undefined;
      const componentId = components?.[1] === 'hostingentries' ? components[2]! : null;
      const serviceId = components?.[1] === 'hostentries' ? components[2]! : null;
      const component = componentId ? await this.store.record(actor, 'component', componentId) : undefined;
      const service = serviceId ? await this.store.record(actor, 'host', serviceId) : undefined;
      if ((componentId && !component) || (serviceId && !service)) return { kind: "Relations indisponibles", text: "Ce composant ou hébergeur/service est introuvable." };
      if ((parentId && !parent) || (technologyId && !technology)) return { kind: "Relations indisponibles", text: "Ce parent ou cette technologie est introuvable." };
      const result = await this.store.records(actor, kind, Number(list?.[2] ?? lookup?.[2] ?? components?.[3]), saved?.selector ?? null, kind === 'tool' ? null : parentId ?? componentId, kind === 'tool' ? parentId : technologyId ?? serviceId);
      const prefix = saved ? `cataloglookup_${lookup![1]}` : components ? `${components[1]}_${components[2]}` : list![1]!;
      return { kind: saved ? `Choisir une fiche : ${label}` : plural, text: `${saved ? "Ce nom est ambigu. Choisissez une fiche.\n" : ''}${parent ? `Projet : ${literal(referenceLabel(parent.fields.name, parent))}\n` : technology ? `Technologie : ${literal(referenceLabel(String(technology.fields.name), technology))}\n` : ''}page ${result.page + 1}/${result.pages} · ${result.total} ${plural}\n${result.records.length ? '' : `Aucune fiche : ${plural} enregistrée.`}`,
        ...await presentation.list(result.records, result.records.map(record => saved?.destination.startsWith('history') ? `history${kind}_${record.id}_0` : `${kind}_${record.id}`)),
        links: [
          ...pages(prefix, result.page, result.pages), ...(kind === 'technology' ? [{ label: "Ajouter une technologie", page: 'addtechnology' }] : kind === 'tool' ? [{ label: "Ajouter un outil", page: 'addtool' }] : kind === 'host' ? [{ label: "Ajouter un hébergeur/service", page: 'addhost' }] : parent ? [{ label: "Ajouter un composant", page: `addcomponent_${parent.id}` }] : component ? [{ label: "Ajouter un hébergement", page: `addhosting_${component.id}` }] : []),
          { label: "Retour", page: parent ? `project_${parent.id}` : technology ? `technology_${technology.id}` : component ? `component_${component.id}` : service ? `host_${service.id}` : 'main' }] };
    }
    const detail = /^(technology|component|host|hosting|tool|edittechnology|editcomponent|edithost|edithosting|edittool)_([^_]+)$/.exec(destination);
    const history = /^history(technology|component|host|hosting|tool)_([^_]+)_(\d{1,6})$/.exec(destination);
    if (detail || history) {
      const kind = (history?.[1] ?? detail![1]!.replace(/^edit/, '')) as RecordKind, label = title(kind);
      const id = detail?.[2] ?? history![2]!;
      const record = await this.store.record(actor, kind, id);
      if (!record) return { kind: `${label} indisponible`, text: `Cette fiche ${label} est introuvable.`, links: [{ label: "Retour", page: 'main' }] };
      if (detail?.[1]?.startsWith('edit') && record.archived) return { kind: "Restauration nécessaire avant modification", text: `${label}: ${literal(await presentation.name(kind, id))}\nÉtat : archivé\nRestaurez explicitement cette fiche avant de la modifier.`, buttons: lifecycleButton(kind, record), links: [{ label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      if (detail?.[1]?.startsWith('edit')) return { kind: `Modifier ${label}`, text: `${label}: ${literal(recordName(record))} (${id})\nUtilisez documentation modifier ${kind} ${id} ${exampleFor(kind)}\n${helpFor(kind)}`, links: [{ label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      if (history) {
        const result = await this.store.recordHistory(actor, kind, id, Number(history[3]));
        const change = result.changes[0];
        return { kind: `Historique — ${label}`, ...(change ? { table: await presentation.values(change.after_values, change.before_values) } : {}), text: `${label}: ${literal(await presentation.name(kind, id))}\n${statusText(record)}\nHistorique — page ${result.page + 1}/${result.pages}\n${change ? `Auteur : ${literal(change.actor)}\nDate : ${formatDate(change.changed_at)}\nSource : ${literal(sourceLabel(change.source))}\n${change.before_values === null ? "Avant : aucune fiche" : ''}` : "Aucune modification n’a été enregistrée."}`,
          links: [...pages(`history${kind}_${id}`, result.page, result.pages), { label: `Retour à ${label}`, page: `${kind}_${id}` }] };
      }
      const technologies = kind === 'component' && Array.isArray(record.fields.technologies)
        ? await Promise.all(record.fields.technologies.map(ref => this.store.record(actor, 'technology', ref))) : [];
      const service = kind === 'hosting' ? await this.store.record(actor, 'host', String(record.fields.serviceId)) : undefined;
      const projects = kind === 'tool' && Array.isArray(record.fields.projects)
        ? await Promise.all(record.fields.projects.map(ref => this.store.project(actor, ref))) : [];
      const details = await presentation.details(record.fields);
      return { kind: label, ...details, text: `${label}: ${literal(await presentation.name(kind, id))}\n${statusText(record)}\n${details.text}`,
        buttons: lifecycleButton(kind, record),
        links: [...(!record.archived ? [{ label: "Modifier", page: `edit${kind}_${id}` }] : []), { label: "Historique", page: `history${kind}_${id}_0` },
        ...(kind === 'tool' ? [...projects.filter(ref => !!ref).map(ref => ({ label: referenceLabel(ref.fields.name, ref), page: `project_${ref.id}` })), { label: "Retour aux outils", page: 'tools_0' }] : kind === 'host' ? [{ label: "Hébergements", page: `hostentries_${id}_0` }, { label: "Retour aux hébergeurs/services", page: 'hosts_0' }] :
          kind === 'hosting' ? [{ label: "Composant", page: `component_${record.fields.componentId}` }, ...(service ? [{ label: referenceLabel(recordName(service), service), page: `host_${service.id}` }] : []), { label: "Retour aux hébergements", page: `hostingentries_${record.fields.componentId}_0` }] :
          kind === 'technology' ? [{ label: "Composants", page: `techcomponents_${id}_0` }, { label: "Retour aux technologies", page: 'technologies_0' }] : [
          { label: "Hébergements", page: `hostingentries_${id}_0` },
          { label: "Projet", page: `project_${record.fields.projectId}` }, ...technologies.filter(ref => !!ref).map(ref => ({ label: referenceLabel(String(ref.fields.name), ref), page: `technology_${ref.id}` })),
          { label: "Retour aux composants", page: `components_${record.fields.projectId}_0` },
        ])] };
    }
    return undefined;
  }
  async handle(actor: Actor, payload: Record<string, unknown>, eventId: string,
    deliver: (message: AgentMessage) => Promise<void>, show: (destination: string) => Promise<void>): Promise<boolean> {
    if (payload.type !== 'text') return false;
    const text = String(payload.text ?? '').trim();
    const list = /^(technologies|hosts|tools)(?:\s+(\d{1,6}))?$/i.exec(text);
    if (list) { await show(`${list[1]!.toLowerCase()}_${list[2] ?? '0'}`); return true; }
    const hosting = /^hosting\s+([\s\S]+)$/i.exec(text);
    if (hosting) {
      const { result, page } = await pagedLookup(hosting[1]!, selector => this.store.lookupRecord(actor, 'component', selector));
      if (result.total === 1) await show(`hostingentries_${result.records[0]!.id}_${page}`);
      else if (result.total > 1) await deliver({ kind: "Composant ambigu", text: "Consultez documentation composant <nom exact> et répétez avec un identifiant stable." });
      else await deliver({ kind: "Composant introuvable", text: "Aucun composant ne correspond exactement à cet identifiant ou nom." });
      return true;
    }
    const components = /^components\s+([\s\S]+)$/i.exec(text);
    if (components) {
      const { selector, result, page } = await pagedLookup(components[1]!, selector => this.store.lookup(actor, selector));
      if (result.total === 1) await show(`components_${result.projects[0]!.id}_${page}`);
      else if (result.total > 1) await show(`lookup_${await this.store.saveLookup(actor, eventId, selector, 'components')}_0`);
      else await deliver({ kind: "Projet introuvable", text: "Aucun projet ne correspond exactement à cet identifiant, nom ou alias." });
      return true;
    }
    const lookup = /^(technology|component|host|tool|hosting-entry|history technology|history component|history host|history tool|history hosting-entry)\s+([\s\S]+)$/i.exec(text);
    if (lookup) {
      const destination = lookup[1]!.toLowerCase().replace(' ', '').replace('hosting-entry', 'hosting'), kind = (destination.replace(/^history/, '')) as RecordKind;
      const selector = lookup[2]!.trim(), result = await this.store.lookupRecord(actor, kind, selector);
      if (result.total === 1) await show(`${destination}_${result.records[0]!.id}${destination.startsWith('history') ? '_0' : ''}`);
      else if (result.total > 1) await show(`cataloglookup_${await this.store.saveLookup(actor, eventId, selector, destination)}_0`);
      else await deliver({ kind: `${title(kind)} introuvable`, text: `Aucune fiche : ${title(kind)} ne correspond exactement à cet identifiant ou nom.` });
      return true;
    }
    return false;
  }
}
