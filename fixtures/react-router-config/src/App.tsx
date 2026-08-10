import { Route, Switch, useNavigate } from 'react-router-dom';
import NotFound from 'pages/NotFound';
import Team from 'pages/Team';

/** A guard wrapper around Route — the v5 idiom this fixture exists to cover. */
function PrivateRoute(props: { path: string; component: unknown }) {
  return <Route {...props} />;
}

export default function App() {
  const navigate = useNavigate();
  return (
    <Switch>
      <Route
        path={'/help/:page?'}
        component={NotFound}
      />
      <PrivateRoute
        path={'/team/:teamId(\\w+)'}
        component={Team}
      />
      <Route path="/reports">
        <Route
          path="quarterly"
          component={NotFound}
        />
      </Route>
      <Route
        path="*"
        component={NotFound}
      />
      <button onClick={() => navigate('/login')}>Sign in</button>
    </Switch>
  );
}
