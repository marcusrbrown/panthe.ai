// Pack loading, lore manifests, and realm definitions.
//
// `loadContentPack` reads an authored world directory (locations + rules
// required; buildings + inhabitants optional) and parses it through
// packages/contracts' `parseContentPack`, so invalid content fails loudly
// at load time with a clear, structured message.

export * from "./load";
