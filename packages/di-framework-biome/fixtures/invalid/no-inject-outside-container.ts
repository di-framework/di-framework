declare class DatabaseService {}

export class UserService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {}

  load() {
    return this.db;
  }
}
