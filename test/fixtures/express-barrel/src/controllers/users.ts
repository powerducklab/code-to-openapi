interface UserItem {
  id: string;
  name: string;
}

export const listUsers = async (req: any, res: any): Promise<UserItem[]> => {
  const q = req.query.q;
  void q;
  return res.json([{ id: "1", name: "Ada" }]);
};
