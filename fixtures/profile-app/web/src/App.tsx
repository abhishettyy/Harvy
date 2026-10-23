import { useState } from "react";
import { LoginPage } from "./pages/LoginPage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";

export function App() {
  const [token, setToken] = useState<string | null>(null);
  return token ? <ProfilePage token={token} /> : <LoginPage onLogin={setToken} />;
}
