interface PostView {
  id: string;
  title: string;
}

// Schema declared as a top-level const and referenced by shorthand identifier
// inside instance.route({ schema, handler }).
const listSchema = {
  response: {
    200: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
        },
        required: ["id", "title"],
      },
    },
  },
};

const listHandler = async (): Promise<PostView[]> => [];

const createHandler = async (): Promise<PostView> => {
  return { id: "p_1", title: "untitled" };
};

const postsPlugin: any = async function (instance: any): Promise<void> {
  instance.route({
    method: "GET",
    url: "/",
    schema: listSchema,
    handler: listHandler,
  });
  // No body schema declared: the request body gap must stay honest rather
  // than being invented.
  instance.route({
    method: "POST",
    url: "/",
    handler: createHandler,
  });
};

export default postsPlugin;
