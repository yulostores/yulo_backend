// In-memory MongoDB for tests that need a real database (models, indexes, queries) — never
// the developer's or production's database. The binary is downloaded by mongodb-memory-server
// on first use and cached.
//
//   const mongo = await startMemoryMongo();
//   ... await mongo.clear();   // between tests, if needed
//   await mongo.stop();

import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

export async function startMemoryMongo() {
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri(), { dbName: 'yulo_test' });

  return {
    uri: server.getUri(),
    async clear() {
      const collections = await mongoose.connection.db.collections();
      await Promise.all(collections.map((c) => c.deleteMany({})));
    },
    async stop() {
      await mongoose.disconnect();
      await server.stop();
    },
  };
}
