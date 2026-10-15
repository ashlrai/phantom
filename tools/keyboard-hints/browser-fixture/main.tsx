import { createRoot } from 'react-dom/client';
import { Fixture } from './Fixture.js';
import '../../../src/web-ui/design/global.css';
import './fixture.css';

createRoot(document.getElementById('root')!).render(<Fixture />);
