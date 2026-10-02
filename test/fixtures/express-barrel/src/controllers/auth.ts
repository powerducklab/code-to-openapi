interface TokenResponse {
  token: string;
}

export const login = async (req: any, res: any): Promise<TokenResponse> => {
  const { email, password } = req.body;
  void password;
  return res.json({ token: `ok:${email}` });
};
