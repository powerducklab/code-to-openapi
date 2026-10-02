import type { User } from "../../types";

// Pages Router handlers are Express-style (req, res). Types come from the
// local annotation on the returned value rather than from framework types.
export default async function handler(req: any, res: any) {
  const user: User = { id: "9", name: "Leg", email: "leg@example.com" };
  res.json(user);
}
