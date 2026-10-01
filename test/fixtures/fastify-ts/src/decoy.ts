// Decoys: property calls on non-fastify objects must never become routes.
const cache = new Map<string, string>();
cache.get("/decoy-map");

const fake = {
  get(path: string) {
    return path;
  },
};
fake.get("/decoy-object");

export {};
