import { Navigate, Route, Routes } from "react-router-dom";
import { useApp } from "./store/appStore";
import { Layout } from "./components/Layout";
import { Loader } from "./components/Loader";
import {
  Auth,
  ChatPage,
  GroupInfoPage,
  GroupsPage,
  MapPage,
  ProfilePage,
  RidePage,
} from "./pages";

function Protected({ children }: { children: React.ReactNode }) {
  const { user, ready } = useApp();
  // Wait for the stored token to be checked, so a reload does not bounce to login.
  if (!ready) return <Loader />;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Auth />} />
      <Route path="/register" element={<Auth register />} />
      {["/", "/map"].map((path) => (
        <Route
          key={path}
          path={path}
          element={
            <Protected>
              <MapPage />
            </Protected>
          }
        />
      ))}
      <Route
        path="/groups"
        element={
          <Protected>
            <GroupsPage />
          </Protected>
        }
      />
      <Route
        path="/groups/:groupId"
        element={
          <Protected>
            <GroupInfoPage />
          </Protected>
        }
      />
      <Route
        path="/ride"
        element={
          <Protected>
            <RidePage />
          </Protected>
        }
      />
      <Route
        path="/chat"
        element={
          <Protected>
            <ChatPage />
          </Protected>
        }
      />
      <Route
        path="/profile"
        element={
          <Protected>
            <ProfilePage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
