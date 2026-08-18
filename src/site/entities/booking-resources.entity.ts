import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { AutoMap } from '@automapper/classes';
import { Site } from './site.entity';

@Entity('booking_resources')
export class BookingResource {
  @AutoMap()
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @AutoMap()
  @Column({ type: 'uuid' })
  siteId: string;

  @ManyToOne(() => Site, (site) => site.bookingResources, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'siteId' })
  site: Site;

  @AutoMap()
  @Column({ type: 'varchar', length: 255 })
  name: string;
}
