export class MaintenanceService {
  @Cron('@daily')
  daily() {
    return 'named';
  }
}
