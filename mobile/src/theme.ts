import { useColorScheme } from 'react-native';

const light = {
  bg: '#FFF7F9',
  surface: '#FFFFFF',
  text: '#1F1720',
  muted: '#8A7F88',
  primary: '#E0457B',
  primaryText: '#FFFFFF',
  inBubble: '#FFFFFF',
  inText: '#1F1720',
  border: '#F0DDE4',
  danger: '#C62828',
};
const dark: typeof light = {
  bg: '#140F14',
  surface: '#211A21',
  text: '#F5EEF3',
  muted: '#A396A0',
  primary: '#F06292',
  primaryText: '#FFFFFF',
  inBubble: '#2B222B',
  inText: '#F5EEF3',
  border: '#3A2E39',
  danger: '#EF5350',
};
export type Theme = typeof light;
export const useTheme = (): Theme => (useColorScheme() === 'dark' ? dark : light);
