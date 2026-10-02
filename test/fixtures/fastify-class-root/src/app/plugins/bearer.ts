// Local stand-in for the fastify-plugin wrapper. The scanner unwraps plugin
// factory calls syntactically, so no runtime dependency is required here.
const fp = (fn: any): any => fn;

export const bearerPlugin: any = async function (instance: any): Promise<void> {
  instance.decorate("user", null);
};

export const bearer = fp(bearerPlugin);
