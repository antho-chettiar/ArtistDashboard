import { PrismaClient } from '@prisma/client';
import { spawn } from 'child_process';
import path from 'path';
import { calculateArtistPopularity } from '../src/utils/artistPopularity';

const prisma = new PrismaClient();

async function updateAllPredictions() {
  try {
    console.log('Starting batch prediction update for all artists and concerts...');
    console.log('Fetching artists and their concerts...');

    // Fetch all artists with their concerts
    const artists = await prisma.artist.findMany({
      include: {
        concerts: true
      }
    });

    let totalConcerts = 0;
    let processedCount = 0;
    let errorCount = 0;

    for (const artist of artists) {
      for (const concert of artist.concerts) {
        totalConcerts++;

        const input = {
          artist_popularity: await calculateArtistPopularity(artist),
          artist_city_popularity: concert.artistCityPopularity ? Number(concert.artistCityPopularity) : 50,
          venue_capacity: concert.capacity ? Number(concert.capacity) : 5000,
          city: concert.city,
          currency: concert.currency || 'INR'
        };

        // Convert input to JSON string for the Python script
        const inputJson = JSON.stringify(input);

        // Call the ML processor
        const processorPath = path.join(__dirname, '..', 'ml_engine', 'processor.py');
        const pythonProcess = spawn('python', [processorPath, inputJson]);

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        // Wrap in Promise to handle async
        const result = await new Promise<{ success: boolean; output: any; error: string | null }>((resolve) => {
          pythonProcess.on('close', (code) => {
            if (code !== 0) {
              resolve({ success: false, output: null, error: stderr || `Process exited with code ${code}` });
            } else {
              try {
                const output = JSON.parse(stdout.trim());
                resolve({ success: true, output, error: null });
              } catch (e) {
                resolve({ success: false, output: null, error: `Failed to parse JSON output: ${e}` });
              }
            }
          });
        });

        if (!result.success) {
          console.error(`Error processing concert ${concert.id}:`, result.error);
          errorCount++;
          continue;
        }

        if (!result.output) {
          console.error(`No output for concert ${concert.id}`);
          errorCount++;
          continue;
        }

        const mlOutput = result.output;
        const concertUpdate = {
          ticketsSold: mlOutput.tickets_sold,
          avgTicketPrice: mlOutput.avg_ticket_price,
          totalRevenue: mlOutput.total_revenue,
          demandScore: mlOutput.demand_score
        };

        // Calculate sellout probability
        const selloutProbability = concert.capacity && concert.capacity > 0
          ? Math.min(0.99, mlOutput.tickets_sold / concert.capacity)
          : 0;

        // Check if prediction already exists for this concert and model version
        const existingPrediction = await prisma.predictionOutput.findFirst({
          where: {
            concertId: concert.id,
            modelVersion: mlOutput.model_version
          }
        });

        if (existingPrediction) {
          // Update existing prediction
          await prisma.predictionOutput.update({
            where: { id: existingPrediction.id },
            data: {
              input: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city: input.city,
                currency: input.currency
              },
              features: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city_market_boost: 0, // Simplified for now
              },
              expectedRevenue: mlOutput.total_revenue, // Already in INR
              expectedAttendance: mlOutput.tickets_sold,
              selloutProbability: Number(selloutProbability.toFixed(4)),
              demandScore: mlOutput.demand_score
            }
          });
        } else {
          // Create new prediction record
          await prisma.predictionOutput.create({
            data: {
              concertId: concert.id,
              modelVersion: mlOutput.model_version,
              input: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city: input.city,
                currency: input.currency
              },
              features: {
                artist_popularity: input.artist_popularity,
                artist_city_popularity: input.artist_city_popularity,
                venue_capacity: input.venue_capacity,
                city_market_boost: 0,
              },
              expectedRevenue: mlOutput.total_revenue, // Already in INR
              expectedAttendance: mlOutput.tickets_sold,
              selloutProbability: Number(selloutProbability.toFixed(4)),
              demandScore: mlOutput.demand_score
            }
          });
        }

        await prisma.concert.update({
          where: { id: concert.id },
          data: concertUpdate
        });

        processedCount++;

        // Progress reporting
        if (processedCount % 50 === 0) {
          console.log(`Processed ${processedCount} concerts...`);
        }
      }
    }

    console.log(`\nFinished processing all concerts.`);
    console.log(`Total concerts found: ${totalConcerts}`);
    console.log(`Successfully processed: ${processedCount}`);
    console.log(`Errors: ${errorCount}`);

    if (processedCount > 0) {
      console.log(`\n✅ Prediction update completed successfully!`);
      console.log(`The PredictionOutput table now contains revenue predictions in INR crores range.`);
    }

  } catch (error) {
    console.error('Unexpected error during batch processing:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// Run the function
updateAllPredictions();
