interface UserView {
  id: string;
  email: string;
}

export const create = async (request: any, reply: any): Promise<UserView> => {
  const body = request.body;
  const user: UserView = { id: "u_1", email: body.email };
  return reply.code(201).send(user);
};

export const getOne = async (request: any, reply: any): Promise<UserView> => {
  return reply.send({ id: "u_1", email: "a@example.com" });
};
