import { serveLocalGraphQLWorker } from "react-crucible/runtime/local-graphql.ts";
import { getLocalDb } from "./db.ts";
import { schema } from "./graphql.ts";

serveLocalGraphQLWorker({
  schema,
  bootstrap: async () => {
    await getLocalDb();
  },
  context: async () => ({
    db: await getLocalDb(),
  }),
});
