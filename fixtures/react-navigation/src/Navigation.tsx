import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { linking } from './linking';
import { HomeScreen } from './screens/Home';
import { MessagesScreen } from './screens/Messages';
import { ProfileScreen } from './screens/Profile';
import { ProfileFeedScreen } from './screens/ProfileFeed';
import { SettingsScreen } from './screens/Settings';

const Stack = createNativeStackNavigator();

/** The target here is a screen name, not a URL — §4.1's hardest case. */
export function OpenProfile() {
  const navigation = useNavigation();
  return <button onClick={() => navigation.navigate('Profile')}>Profile</button>;
}

export function Navigation() {
  return (
    <NavigationContainer linking={linking}>
      <Stack.Navigator>
        <Stack.Screen
          name="Home"
          component={HomeScreen}
        />
        <Stack.Screen
          name="Profile"
          component={ProfileScreen}
        />
        <Stack.Screen
          name="ProfileFeed"
          getComponent={() => ProfileFeedScreen}
        />
        <Stack.Screen
          name="Settings"
          component={SettingsScreen}
        />
        <Stack.Screen
          name="Messages"
          component={MessagesScreen}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
