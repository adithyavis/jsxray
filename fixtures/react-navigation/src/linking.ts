/** The deep-linking config, where paths are relative and nest under `screens`. */
export const linking = {
  prefixes: ['https://example.app'],
  config: {
    screens: {
      Messages: {
        path: 'messages',
        screens: {
          Conversation: ':conversationId',
          Inbox: 'inbox',
        },
      },
    },
  },
};
