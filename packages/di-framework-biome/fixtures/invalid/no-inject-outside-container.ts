export class UserService {
  constructor(@Component(DatabaseService) private db: DatabaseService) {
    this.db = db;
  }
}

declare class DatabaseService {}
