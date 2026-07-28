import {
  Column,
  Entity,
  ManyToMany,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Site } from '../../site/entities/site.entity';
import { UserRole } from '../enums/user-role.enum';
import { AutoMap } from '@automapper/classes';

@Entity('users')
export class User {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ unique: true })
  email: string;

  @Column()
  password: string;

  @AutoMap()
  @Column()
  name: string;

  @AutoMap()
  @Column({
    type: 'enum',
    enum: UserRole,
    default: UserRole.AGENT,
  })
  role: UserRole;

  @AutoMap()
  @Column({ default: false })
  twoFactorEnabled: boolean;

  @Column({ type: 'varchar', nullable: true })
  twoFactorSecret: string | null;

  @OneToMany(() => Site, (site) => site.owner)
  sites: Site[];

  @ManyToMany(() => Site, (site) => site.agents)
  assignedSites: Site[];
}
