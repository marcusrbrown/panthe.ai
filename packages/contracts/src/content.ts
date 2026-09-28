// Authored world content (content/greek/world/*.json): realms, locations
// and edges, buildings, inhabitants, the resource graph, and numeric
// rules. Content ids are plain strings (authoring-time keys), not branded
// EntityId values -- packages/world mints live EntityIds when it
// instantiates a pack. Invalid content fails loudly at load, so every
// field here is parsed, never assumed.

import {
  fail,
  isRecord,
  ok,
  type ParseResult,
  parseArray,
  parseBoolean,
  parseEnum,
  parseFiniteNumber,
  parseNonNegativeInteger,
  parseNonNegativeNumber,
  parseOptionalString,
  parseResourceAmount,
  parseSchemaVersion,
  parseString,
  type ResourceAmount,
} from "./ids";

export const CONTENT_SCHEMA_VERSIONS = [1] as const;

export const REALMS = ["mortal", "olympus", "underworld"] as const;
export type Realm = (typeof REALMS)[number];

export const TRANSPORT_KINDS = ["path", "portal", "divine-transport"] as const;
export type TransportKind = (typeof TRANSPORT_KINDS)[number];

export interface LocationEdge {
  readonly to: string;
  readonly transport: TransportKind;
  readonly bidirectional: boolean;
}

export interface Location {
  readonly id: string;
  readonly realm: Realm;
  readonly name: string;
  readonly edges: readonly LocationEdge[];
  /**
   * Capability an actor must hold to enter this location, optional and
   * additive: gates both `move` and `realm-transition` proposals whose
   * destination names this location, so a restricted destination (e.g. a
   * divine-only sanctum) rejects entry with reason `restricted-realm`
   * distinctly from a plain adjacency failure. Absent means unrestricted.
   */
  readonly requiredCapability?: string;
}

export interface Building {
  readonly id: string;
  readonly locationId: string;
  readonly name: string;
  readonly material: string;
  readonly services: readonly string[];
  readonly inventory: readonly ResourceAmount[];
  readonly owner?: string;
}

export interface InhabitantDrives {
  readonly thrift: number;
  readonly appetite: number;
  readonly greed: number;
  readonly piety: number;
}

export interface Inhabitant {
  readonly id: string;
  readonly name: string;
  readonly locationId: string;
  readonly drives: InhabitantDrives;
}

export interface WorldRules {
  readonly catchUpCapMs: number;
  readonly catchUpChunkMs: number;
  readonly checkpointIntervalMs: number;
  readonly fireBalance: Readonly<Record<string, number>>;
  readonly economyBalance: Readonly<Record<string, number>>;
}

export interface ContentPack {
  readonly schemaVersion: number;
  readonly realms: readonly Realm[];
  readonly resources: readonly ResourceAmount[];
  readonly locations: readonly Location[];
  readonly buildings: readonly Building[];
  readonly inhabitants: readonly Inhabitant[];
  readonly rules: WorldRules;
}

function parseLocationEdge(
  value: unknown,
  path: string,
): ParseResult<LocationEdge> {
  if (!isRecord(value)) return fail(path, "expected a location edge entry");
  const to = parseString(value.to, `${path}.to`);
  if (!to.ok) return to;
  const transport = parseEnum(
    value.transport,
    `${path}.transport`,
    TRANSPORT_KINDS,
  );
  if (!transport.ok) return transport;
  const bidirectional = parseBoolean(
    value.bidirectional,
    `${path}.bidirectional`,
  );
  if (!bidirectional.ok) return bidirectional;
  return ok({
    to: to.value,
    transport: transport.value,
    bidirectional: bidirectional.value,
  });
}

function parseLocation(value: unknown, path: string): ParseResult<Location> {
  if (!isRecord(value)) return fail(path, "expected a location entry");
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  const realm = parseEnum(value.realm, `${path}.realm`, REALMS);
  if (!realm.ok) return realm;
  const name = parseString(value.name, `${path}.name`);
  if (!name.ok) return name;
  const edges = parseArray(value.edges, `${path}.edges`, parseLocationEdge);
  if (!edges.ok) return edges;
  const requiredCapability = parseOptionalString(
    value.requiredCapability,
    `${path}.requiredCapability`,
  );
  if (!requiredCapability.ok) return requiredCapability;
  return ok({
    id: id.value,
    realm: realm.value,
    name: name.value,
    edges: edges.value,
    ...(requiredCapability.value === undefined
      ? {}
      : { requiredCapability: requiredCapability.value }),
  });
}

function parseBuilding(value: unknown, path: string): ParseResult<Building> {
  if (!isRecord(value)) return fail(path, "expected a building entry");
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  const locationId = parseString(value.locationId, `${path}.locationId`);
  if (!locationId.ok) return locationId;
  const name = parseString(value.name, `${path}.name`);
  if (!name.ok) return name;
  const material = parseString(value.material, `${path}.material`);
  if (!material.ok) return material;
  const services = parseArray(value.services, `${path}.services`, parseString);
  if (!services.ok) return services;
  const inventory = parseArray(
    value.inventory,
    `${path}.inventory`,
    parseResourceAmount,
  );
  if (!inventory.ok) return inventory;
  const owner = parseOptionalString(value.owner, `${path}.owner`);
  if (!owner.ok) return owner;
  return ok({
    id: id.value,
    locationId: locationId.value,
    name: name.value,
    material: material.value,
    services: services.value,
    inventory: inventory.value,
    ...(owner.value === undefined ? {} : { owner: owner.value }),
  });
}

function parseInhabitantDrives(
  value: unknown,
  path: string,
): ParseResult<InhabitantDrives> {
  if (!isRecord(value)) return fail(path, "expected a drives object");
  const thrift = parseNonNegativeNumber(value.thrift, `${path}.thrift`);
  if (!thrift.ok) return thrift;
  const appetite = parseNonNegativeNumber(value.appetite, `${path}.appetite`);
  if (!appetite.ok) return appetite;
  const greed = parseNonNegativeNumber(value.greed, `${path}.greed`);
  if (!greed.ok) return greed;
  const piety = parseNonNegativeNumber(value.piety, `${path}.piety`);
  if (!piety.ok) return piety;
  return ok({
    thrift: thrift.value,
    appetite: appetite.value,
    greed: greed.value,
    piety: piety.value,
  });
}

function parseInhabitant(
  value: unknown,
  path: string,
): ParseResult<Inhabitant> {
  if (!isRecord(value)) return fail(path, "expected an inhabitant entry");
  const id = parseString(value.id, `${path}.id`);
  if (!id.ok) return id;
  const name = parseString(value.name, `${path}.name`);
  if (!name.ok) return name;
  const locationId = parseString(value.locationId, `${path}.locationId`);
  if (!locationId.ok) return locationId;
  const drives = parseInhabitantDrives(value.drives, `${path}.drives`);
  if (!drives.ok) return drives;
  return ok({
    id: id.value,
    name: name.value,
    locationId: locationId.value,
    drives: drives.value,
  });
}

function parseBalanceRecord(
  value: unknown,
  path: string,
): ParseResult<Readonly<Record<string, number>>> {
  if (!isRecord(value)) return fail(path, "expected a balance object");
  const balance: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    const parsed = parseFiniteNumber(entry, `${path}.${key}`);
    if (!parsed.ok) return parsed;
    balance[key] = parsed.value;
  }
  return ok(balance);
}

function parseWorldRules(
  value: unknown,
  path: string,
): ParseResult<WorldRules> {
  if (!isRecord(value)) return fail(path, "expected a rules object");
  const catchUpCapMs = parseNonNegativeInteger(
    value.catchUpCapMs,
    `${path}.catchUpCapMs`,
  );
  if (!catchUpCapMs.ok) return catchUpCapMs;
  const catchUpChunkMs = parseNonNegativeInteger(
    value.catchUpChunkMs,
    `${path}.catchUpChunkMs`,
  );
  if (!catchUpChunkMs.ok) return catchUpChunkMs;
  const checkpointIntervalMs = parseNonNegativeInteger(
    value.checkpointIntervalMs,
    `${path}.checkpointIntervalMs`,
  );
  if (!checkpointIntervalMs.ok) return checkpointIntervalMs;
  const fireBalance = parseBalanceRecord(
    value.fireBalance,
    `${path}.fireBalance`,
  );
  if (!fireBalance.ok) return fireBalance;
  const economyBalance = parseBalanceRecord(
    value.economyBalance,
    `${path}.economyBalance`,
  );
  if (!economyBalance.ok) return economyBalance;
  return ok({
    catchUpCapMs: catchUpCapMs.value,
    catchUpChunkMs: catchUpChunkMs.value,
    checkpointIntervalMs: checkpointIntervalMs.value,
    fireBalance: fireBalance.value,
    economyBalance: economyBalance.value,
  });
}

/**
 * Referential integrity, run after every field has already shape-parsed
 * successfully. Shape parsing alone lets a syntactically valid pack
 * reference geography that does not exist -- an edge to a phantom
 * location, a building or inhabitant planted in a location that was never
 * declared, a location realm the pack never lists, or two locations
 * fighting over one id. Each of those loads as "valid" content right up
 * until packages/world tries to use it, so this fails loudly at the same
 * parse boundary as every other content error instead of surfacing later
 * as a confusing runtime lookup miss.
 */
function checkReferentialIntegrity(
  pack: ContentPack,
): ParseResult<ContentPack> {
  const declaredRealms = new Set<Realm>(pack.realms);
  const locationIds = new Set<string>();

  for (const [index, location] of pack.locations.entries()) {
    if (locationIds.has(location.id)) {
      return fail(
        `locations[${index}].id`,
        `duplicate location id: ${location.id}`,
      );
    }
    locationIds.add(location.id);
  }

  for (const [index, location] of pack.locations.entries()) {
    if (!declaredRealms.has(location.realm)) {
      return fail(
        `locations[${index}].realm`,
        `location "${location.id}" declares realm "${location.realm}", which is not listed in the pack's realms`,
      );
    }
    for (const [edgeIndex, edge] of location.edges.entries()) {
      if (!locationIds.has(edge.to)) {
        return fail(
          `locations[${index}].edges[${edgeIndex}].to`,
          `edge from "${location.id}" targets unknown location: ${edge.to}`,
        );
      }
    }
  }

  for (const [index, building] of pack.buildings.entries()) {
    if (!locationIds.has(building.locationId)) {
      return fail(
        `buildings[${index}].locationId`,
        `building "${building.id}" references unknown location: ${building.locationId}`,
      );
    }
  }

  for (const [index, inhabitant] of pack.inhabitants.entries()) {
    if (!locationIds.has(inhabitant.locationId)) {
      return fail(
        `inhabitants[${index}].locationId`,
        `inhabitant "${inhabitant.id}" references unknown location: ${inhabitant.locationId}`,
      );
    }
  }

  return ok(pack);
}

export function parseContentPack(input: unknown): ParseResult<ContentPack> {
  if (!isRecord(input)) {
    return fail("", "expected a content pack object");
  }
  const schemaVersion = parseSchemaVersion(
    input.schemaVersion,
    CONTENT_SCHEMA_VERSIONS,
  );
  if (!schemaVersion.ok) return schemaVersion;
  const realms = parseArray(input.realms, "realms", (item, path) =>
    parseEnum(item, path, REALMS),
  );
  if (!realms.ok) return realms;
  const resources = parseArray(
    input.resources,
    "resources",
    parseResourceAmount,
  );
  if (!resources.ok) return resources;
  const locations = parseArray(input.locations, "locations", parseLocation);
  if (!locations.ok) return locations;
  const buildings = parseArray(input.buildings, "buildings", parseBuilding);
  if (!buildings.ok) return buildings;
  const inhabitants = parseArray(
    input.inhabitants,
    "inhabitants",
    parseInhabitant,
  );
  if (!inhabitants.ok) return inhabitants;
  const rules = parseWorldRules(input.rules, "rules");
  if (!rules.ok) return rules;
  return checkReferentialIntegrity({
    schemaVersion: schemaVersion.value,
    realms: realms.value,
    resources: resources.value,
    locations: locations.value,
    buildings: buildings.value,
    inhabitants: inhabitants.value,
    rules: rules.value,
  });
}
