export class MaintenanceService {
  @Cron('0 0 * * * *')
  nightly() {
    return 'too many fields';
  }

  @Cron('@daily')
  daily() {
    return 'named';
  }
}
