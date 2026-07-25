export type RetainedNotificationLifetime = {
  release: () => void;
  fail: (error: unknown) => void;
};

export function retainNotification<T>(
  activeNotifications: Set<T>,
  notification: T,
  onFailure: (error: unknown) => void,
): RetainedNotificationLifetime {
  activeNotifications.add(notification);
  const release = () => {
    activeNotifications.delete(notification);
  };
  return {
    release,
    fail: (error) => {
      release();
      try {
        onFailure(error);
      } catch {
        // Native failure cleanup must survive diagnostics failing too.
      }
    },
  };
}
