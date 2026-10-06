export class User {
  @GeneratedValue({ strategy: 'uuid' })
  publicId!: string;
}
