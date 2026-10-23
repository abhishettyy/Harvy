import { useEffect, useState } from "react";
import { getProfile, type Profile } from "../api/profile.ts";

export function ProfilePage({ token }: { token: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProfile(token).then(setProfile, (e: Error) => setError(e.message));
  }, [token]);

  if (error) return <p role="alert">{error}</p>;
  if (!profile) return <p>Loading…</p>;
  return (
    <section>
      <h1>{profile.displayName}</h1>
      <p>{profile.email}</p>
      <p>{profile.bio}</p>
    </section>
  );
}
