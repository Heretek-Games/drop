/**
 * Object permissions for a screenshot (#20 screenshot gallery).
 *
 * The owner always keeps read access; public screenshots additionally grant
 * `anonymous:read`, which the object handler treats as readable by anyone.
 */
export function screenshotObjectPermissions(
  userId: string,
  isPrivate: boolean,
): string[] {
  return isPrivate ? [`${userId}:read`] : [`${userId}:read`, "anonymous:read"];
}
