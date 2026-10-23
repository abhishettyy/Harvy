import { createApp } from "./app.ts";
import { openDatabase, seedDemoUser } from "./db.ts";

const secret = process.env.JWT_SECRET ?? "dev-only-secret";
const db = openDatabase(process.env.DB_PATH ?? "profile-app.sqlite");
seedDemoUser(db);
const port = Number(process.env.PORT ?? 4000);
createApp(db, secret).listen(port, () => console.log(`api on http://localhost:${port}`));
