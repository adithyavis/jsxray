import { useNavigation } from '@react-navigation/native';

/** `navigate` takes a screen name; only the linking config turns it into a route. */
export function HomeScreen() {
  const navigation = useNavigation();
  return <button onClick={() => navigation.navigate('ProfileFeed')}>Open feed</button>;
}
