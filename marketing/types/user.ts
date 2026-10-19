export type UserType = {
  sId: string;
  id: number;
  createdAt: number;
  provider: "auth0" | "github" | "google" | "okta" | "samlp" | "waad" | null;
  username: string;
  email: string;
  firstName: string;
  lastName: string | null;
  fullName: string;
  image: string | null;
  lastLoginAt: number | null;
};
